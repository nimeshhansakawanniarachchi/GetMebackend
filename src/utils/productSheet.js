// =====================================================
// PRODUCT SPREADSHEETS (bulk import)
// Reads a shop's .xlsx / .csv into product form fields and builds
// the blank template. Values come out as strings for readProduct.
// =====================================================

const path = require('path');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const { barcodeFormat } = require('./barcode');

const MAX_ROWS = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Pictures in this column become the product photo ("Barcode Image"
// and other picture columns are ignored)
const PHOTO_HEADERS = ['photo', 'image', 'picture', 'productimage', 'productphoto', 'productpicture'];

// Template columns, in order. `aliases` also accept common headings
// from other systems (e.g. an UltimatePOS export).
const COLUMNS = [
  { key: 'productName', header: 'Product name *', width: 34, aliases: ['name', 'product', 'item', 'itemname'] },
  { key: 'category', header: 'Category *', width: 24, aliases: [] },
  { key: 'price', header: 'Price (Rs) *', width: 13, aliases: ['sellingprice', 'unitprice'] },
  { key: 'stockQuantity', header: 'Stock *', width: 10, aliases: ['stockquantity', 'quantity', 'qty', 'openingstock', 'currentstock'] },
  { key: 'unit', header: 'Sold as', width: 12, aliases: ['unit'] },
  { key: 'barcode', header: 'Barcode', width: 18, aliases: ['ean', 'upc', 'gtin'] },
  { key: 'brand', header: 'Brand', width: 16, aliases: [] },
  { key: 'size', header: 'Size', width: 12, aliases: [] },
  { key: 'description', header: 'Description', width: 40, aliases: ['productdescription'] },
  { key: 'isAvailable', header: 'Available', width: 11, aliases: ['isavailable'] },
];

// "Price (Rs) *" -> "price", "OPENING STOCK" -> "openingstock"
const headerKey = (value) =>
  String(value ?? '')
    .replace(/\(.*?\)/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const FIELD_BY_HEADER = new Map(
  COLUMNS.flatMap((column) =>
    [headerKey(column.header), headerKey(column.key), ...column.aliases].map((name) => [name, column.key])
  )
);

const UNIT_WORDS = {
  item: [
    'each', 'item', 'items', 'piece', 'pieces', 'pc', 'pcs', 'nos', 'no', 'unit', 'units',
    'pack', 'packs', 'packet', 'packets', 'bottle', 'bottles', 'can', 'cans', 'box', 'boxes',
    'bag', 'bags', 'bar', 'bars', 'jar', 'jars', 'tin', 'tins', 'sachet', 'sachets', 'roll', 'rolls',
  ],
  kg: ['perkg', 'kg', 'kgs', 'kilo', 'kilogram', 'kilograms'],
  L: ['perlitre', 'perliter', 'l', 'ltr', 'litre', 'liter', 'litres', 'liters'],
};

const YES = ['yes', 'y', 'true', '1', 'available', 'show'];
const NO = ['no', 'n', 'false', '0', 'unavailable', 'hidden', 'hide'];

// exceljs cell value -> number | string ('' when empty)
const cellValue = (value) => {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('result' in value) return cellValue(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('text' in value) return cellValue(value.text);
    return '';
  }

  return typeof value === 'number' ? value : String(value).trim();
};

// "1,050.00" / "Rs 250" -> "1050.00"; "5.00 Pieces" -> "5.00"
const numberText = (value) => {
  if (typeof value === 'number') return String(value);

  const match = String(value).replace(/,/g, '').match(/-?\d*\.?\d+/);

  return match ? match[0] : String(value);
};

// Excel drops a barcode's leading zeros when the cell is a number;
// put them back when that makes a valid UPC-A / EAN-13 / EAN-8
const barcodeText = (value) => {
  const changed = { error: 'Barcode was changed by Excel. Format the Barcode column as Text and type it again' };

  if (typeof value !== 'number') {
    const text = String(value).replace(/\s+/g, '');

    // e.g. "4.79202E+12" in a CSV saved from Excel
    return /^\d(\.\d+)?e\+\d+$/i.test(text) ? changed : { barcode: text };
  }

  if (!Number.isSafeInteger(value) || value < 0) return changed;

  const digits = String(value);

  if (barcodeFormat(digits) === 'OTHER') {
    const padded = [12, 13, 8]
      .filter((length) => length > digits.length && length - digits.length <= 2)
      .map((length) => digits.padStart(length, '0'))
      .find((code) => !['OTHER', null].includes(barcodeFormat(code)));

    if (padded) return { barcode: padded };
  }

  return { barcode: digits };
};

const unitText = (value) => {
  const word = headerKey(value);

  if (!word) return { unit: 'item' };

  const unit = Object.keys(UNIT_WORDS).find((key) => UNIT_WORDS[key].includes(word));

  return unit ? { unit } : { error: 'Sold as must be Each, Per kg or Per litre' };
};

const availableText = (value) => {
  const word = String(value).trim().toLowerCase();

  if (!word || YES.includes(word)) return { isAvailable: 'true' };
  if (NO.includes(word)) return { isAvailable: 'false' };

  return { error: 'Available must be Yes or No' };
};

// One sheet row -> { fields } for readProduct, or { error }
const rowFields = (raw) => {
  const barcode = barcodeText(raw.barcode ?? '');
  const unit = unitText(raw.unit ?? '');
  const available = availableText(raw.isAvailable ?? '');
  const error = barcode.error || unit.error || available.error;

  if (error) return { error, fields: { productName: String(raw.productName ?? '') } };

  return {
    fields: {
      productName: String(raw.productName ?? ''),
      category: String(raw.category ?? ''),
      price: raw.price === '' || raw.price == null ? '' : numberText(raw.price),
      stockQuantity: raw.stockQuantity === '' || raw.stockQuantity == null ? '' : numberText(raw.stockQuantity),
      unit: unit.unit,
      barcode: barcode.barcode,
      brand: String(raw.brand ?? ''),
      size: String(raw.size ?? ''),
      description: String(raw.description ?? ''),
      isAvailable: available.isAvailable,
    },
  };
};

// ---------- Pictures placed over cells ----------
// Read straight from the package: exceljs can't parse drawings written
// without the xdr: prefix (e.g. by openpyxl), so they're also removed
// before exceljs reads the cells.

const attribute = (xml, name) => xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// Relationship targets are absolute ("/xl/media/a.png") or relative to the part
const resolveTarget = (partPath, target) =>
  target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(partPath), target);

const relsOf = async (zip, partPath) => {
  const relsPath = `${path.posix.dirname(partPath)}/_rels/${path.posix.basename(partPath)}.rels`;
  const xml = (await zip.file(relsPath)?.async('string')) || '';

  return [...xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map(([tag]) => ({
    id: attribute(tag, 'Id'),
    type: attribute(tag, 'Type') || '',
    target: resolveTarget(partPath, attribute(tag, 'Target') || ''),
  }));
};

const imageType = (buffer) => {
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';

  return null;
};

const blocks = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g'))]
    .map(([, attributes, body]) => ({ attributes, body }));

const partText = async (zip, partPath) => (partPath && (await zip.file(partPath)?.async('string'))) || '';

// "K12" -> { col: 11, row: 12 }
const cellPosition = (ref) => {
  const [, letters, digits] = String(ref).match(/^([A-Z]+)(\d+)$/) || [];

  if (!letters) return null;

  const col = [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);

  return { col, row: Number(digits) };
};

// Pictures placed in cells (Excel 365 "Place in Cell") are rich values:
// cell vm -> valueMetadata -> futureMetadata rvb -> rich value -> its
// _rvRel:LocalImageIdentifier -> richValueRel -> media.
// Returns the media path for each vm (index vm - 1), or null.
const readCellImageTargets = async (zip, workbookRels) => {
  const partOf = (suffix) => workbookRels.find((rel) => rel.type.endsWith(suffix))?.target;
  const metadata = await partText(zip, partOf('/sheetMetadata'));
  const relPath = partOf('/richValueRel');

  if (!metadata || !relPath) return [];

  const types = [...metadata.matchAll(/<(?:\w+:)?metadataType\b[^>]*>/g)].map(([tag]) => attribute(tag, 'name'));
  const richType = types.indexOf('XLRICHVALUE') + 1;
  const future = blocks(metadata, 'futureMetadata').find((block) => attribute(block.attributes, 'name') === 'XLRICHVALUE');
  const richIndexes = future ? blocks(future.body, 'bk').map((bk) => Number(attribute(bk.body, 'i'))) : [];
  const valueMetadata = blocks(metadata, 'valueMetadata')[0]?.body || '';

  const structures = blocks(await partText(zip, partOf('/rdRichValueStructure')), 's').map((structure) =>
    [...structure.body.matchAll(/<(?:\w+:)?k\b[^>]*>/g)].map(([tag]) => attribute(tag, 'n'))
  );
  const richValues = blocks(await partText(zip, partOf('/rdRichValue')), 'rv').map((rv) => ({
    keys: structures[Number(attribute(rv.attributes, 's'))] || [],
    values: [...rv.body.matchAll(/<(?:\w+:)?v\b[^>]*>([^<]*)</g)].map(([, value]) => value),
  }));

  const relIds = [...(await partText(zip, relPath)).matchAll(/<(?:\w+:)?rel\b[^>]*>/g)].map(([tag]) => attribute(tag, 'r:id'));
  const media = await relsOf(zip, relPath);

  return blocks(valueMetadata, 'bk').map((bk) => {
    const rc = bk.body.match(/<(?:\w+:)?rc\b[^>]*>/)?.[0] || '';

    if (Number(attribute(rc, 't')) !== richType) return null;

    const rich = richValues[richIndexes[Number(attribute(rc, 'v'))]];
    const slot = rich?.keys.indexOf('_rvRel:LocalImageIdentifier');

    if (!rich || slot < 0) return null;

    const relId = relIds[Number(rich.values[slot])];

    return media.find((rel) => rel.id === relId)?.target || null;
  });
};

// WPS Office in-cell pictures: the cell holds =DISPIMG("ID_...",1) and
// xl/cellimages.xml lists each picture by that ID. Returns ID -> media path.
const readWpsCellImages = async (zip, workbookRels) => {
  const partPath = workbookRels.find((rel) => rel.type.endsWith('/cellImage'))?.target || 'xl/cellimages.xml';
  const xml = await partText(zip, partPath);

  if (!xml) return new Map();

  const media = await relsOf(zip, partPath);

  return new Map(
    blocks(xml, 'cellImage')
      .map(({ body }) => [
        attribute(body.match(/<(?:\w+:)?cNvPr\b[^>]*>/)?.[0] || '', 'name'),
        media.find((rel) => rel.id === attribute(body, 'r:embed'))?.target,
      ])
      .filter(([id, target]) => id && target)
  );
};

// Sheet name -> [{ row, col (1-based), buffer, extension }]
const readPictures = async (zip) => {
  const workbookPath = 'xl/workbook.xml';
  const workbookXml = (await zip.file(workbookPath)?.async('string')) || '';
  const workbookRels = await relsOf(zip, workbookPath);
  const cellImageTargets = await readCellImageTargets(zip, workbookRels);
  const wpsImages = await readWpsCellImages(zip, workbookRels);
  const pictures = new Map();

  for (const [sheetTag] of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const sheetPath = workbookRels.find((rel) => rel.id === attribute(sheetTag, 'r:id'))?.target;
    const drawings = sheetPath ? (await relsOf(zip, sheetPath)).filter((rel) => rel.type.endsWith('/drawing')) : [];
    const found = [];

    // In-cell pictures: cells carrying a vm (value metadata) index
    if (sheetPath && cellImageTargets.length > 0) {
      for (const [cellTag] of (await partText(zip, sheetPath)).matchAll(/<(?:\w+:)?c\b[^>]*>/g)) {
        const vm = Number(attribute(cellTag, 'vm'));
        const target = vm ? cellImageTargets[vm - 1] : null;
        const position = target && cellPosition(attribute(cellTag, 'r'));
        const buffer = position ? await zip.file(target)?.async('nodebuffer') : null;

        if (buffer) found.push({ ...position, buffer, extension: imageType(buffer) });
      }
    }

    // WPS in-cell pictures: cells whose formula is DISPIMG("ID_...")
    if (sheetPath && wpsImages.size > 0) {
      const sheetXml = await partText(zip, sheetPath);
      const cells = sheetXml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/(?:\w+:)?c>/g);

      for (const [, cellAttributes, body] of cells) {
        const id = body.match(/DISPIMG\((?:"|&quot;)([^"&]+)(?:"|&quot;)/)?.[1];
        const target = id && wpsImages.get(id);
        const position = target && cellPosition(attribute(cellAttributes, 'r'));
        const buffer = position ? await zip.file(target)?.async('nodebuffer') : null;

        if (buffer) found.push({ ...position, buffer, extension: imageType(buffer) });
      }
    }

    for (const drawing of drawings) {
      const xml = (await zip.file(drawing.target)?.async('string')) || '';
      const media = await relsOf(zip, drawing.target);
      const anchors = xml.matchAll(/<(?:\w+:)?(oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:\w+:)?\1>/g);

      for (const [anchor] of anchors) {
        const from = anchor.match(/<(?:\w+:)?from>[\s\S]*?<(?:\w+:)?col>(\d+)<[\s\S]*?<(?:\w+:)?row>(\d+)</);
        const target = media.find((rel) => rel.id === attribute(anchor, 'r:embed'))?.target;
        const buffer = from && target ? await zip.file(target)?.async('nodebuffer') : null;

        if (buffer) {
          found.push({ col: Number(from[1]) + 1, row: Number(from[2]) + 1, buffer, extension: imageType(buffer) });
        }
      }
    }

    pictures.set(attribute(sheetTag, 'name'), found);
  }

  return pictures;
};

// Same package without its drawings, so exceljs only reads the cells
const withoutDrawings = async (zip) => {
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/drawings\//.test(name)) zip.remove(name);

    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      const xml = await zip.file(name).async('string');
      zip.file(name, xml.replace(/<(?:\w+:)?drawing\b[^>]*\/>/g, ''));
    }
  }

  return zip.generateAsync({ type: 'nodebuffer' });
};

const loadWorkbook = async (buffer, fileName) => {
  const workbook = new ExcelJS.Workbook();

  if (/\.csv$/i.test(fileName)) {
    // Keep every value as text so barcodes keep their leading zeros
    await workbook.csv.read(Readable.from(buffer), { map: (value) => value });

    return { workbook, pictures: new Map() };
  }

  const zip = await JSZip.loadAsync(buffer);
  const pictures = await readPictures(zip);
  await workbook.xlsx.load(await withoutDrawings(zip));

  return { workbook, pictures };
};

// The heading row may sit below a title (exports often add one)
const findHeader = (sheet) => {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 10); rowNumber += 1) {
    const fields = new Map();
    let photoColumn = null;

    sheet.getRow(rowNumber).eachCell((cell, columnNumber) => {
      const key = headerKey(cellValue(cell.value));
      const field = FIELD_BY_HEADER.get(key);

      if (field && ![...fields.values()].includes(field)) fields.set(columnNumber, field);
      if (!photoColumn && PHOTO_HEADERS.includes(key)) photoColumn = columnNumber;
    });

    if ([...fields.values()].includes('productName') && [...fields.values()].includes('price')) {
      return { rowNumber, fields, photoColumn };
    }
  }

  return null;
};

// The picture over a row's Photo cell -> { image } | { imageError } | {}
const rowPhoto = (pictures, rowNumber, photoColumn) => {
  const picture = photoColumn && pictures.find((item) => item.row === rowNumber && item.col === photoColumn);

  if (!picture) return {};
  if (!picture.extension) return { imageError: 'Photo skipped: it must be a JPG, PNG or WEBP picture' };
  if (picture.buffer.length > MAX_IMAGE_BYTES) return { imageError: 'Photo skipped: it is larger than 5MB' };

  return { image: { buffer: picture.buffer, extension: picture.extension } };
};

/**
 * Buffer of an .xlsx / .csv -> { rows: [{ row, fields, image?, imageError? } | { row, error }] }
 * or { error } when the file can't be used at all.
 */
const readProductSheet = async (buffer, fileName) => {
  let workbook;
  let pictures;

  try {
    ({ workbook, pictures } = await loadWorkbook(buffer, fileName));
  } catch {
    return { error: 'This file could not be read. Save it as .xlsx or .csv and try again.' };
  }

  const sheet = workbook.worksheets.find((candidate) => findHeader(candidate));
  const header = sheet && findHeader(sheet);

  if (!header) {
    return { error: 'No heading row found. Use the GetMe template, or include at least "Product name" and "Price" columns.' };
  }

  const rows = [];

  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const raw = {};

    header.fields.forEach((field, columnNumber) => {
      raw[field] = cellValue(sheet.getRow(rowNumber).getCell(columnNumber).value);
    });

    if (Object.values(raw).every((value) => value === '')) continue;

    if (rows.length === MAX_ROWS) {
      return { error: `This file has more than ${MAX_ROWS} products. Split it into smaller files.` };
    }

    rows.push({
      row: rowNumber,
      ...rowFields(raw),
      ...rowPhoto(pictures.get(sheet.name) || [], rowNumber, header.photoColumn),
    });
  }

  if (rows.length === 0) {
    return { error: 'The file has no products below the heading row.' };
  }

  return { rows };
};

const TEMPLATE_HELP = [
  ['Column', 'What to enter'],
  ['Product name *', 'Name customers see, 2-150 characters, e.g. Anchor Full Cream Milk Powder 400g'],
  ['Category *', 'e.g. Dairy & Eggs, Beverages, Snacks & Confectionery'],
  ['Price (Rs) *', 'Selling price. For Per kg / Per litre items, the price of 1 kg / 1 litre'],
  ['Stock *', 'Whole number of items (or kg / litres) you have now. Updating a product replaces its stock'],
  ['Sold as', 'Each (default), Per kg or Per litre'],
  ['Barcode', 'EAN / UPC printed on the pack, or your own code. Leave blank if none. Products you already list are matched by barcode'],
  ['Brand', 'Optional'],
  ['Size', 'Optional, e.g. 400g, 1L'],
  ['Description', 'Optional'],
  ['Available', 'Yes (default) or No to hide it from customers'],
  ['Photo', 'Optional. Excel: click the cell, then Insert > Pictures > Place in Cell (or Place over Cells, or paste a picture onto it). WPS: Insert > Picture > Embed in Cell, or float it over the cell. JPG, PNG or WEBP, up to 5MB'],
  ['', ''],
  ['No photo?', 'Products with a known manufacturer barcode get the GetMe catalogue photo. Add or change photos later in Products > Edit'],
];

/** Blank import template as an .xlsx buffer. */
const buildProductTemplate = async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = [
    ...COLUMNS.map(({ key, header, width }) => ({ key, header, width })),
    { key: 'photo', header: 'Photo', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };
  // Text, so Excel keeps leading zeros and long numbers as typed
  sheet.getColumn('barcode').numFmt = '@';

  // Drop-downs as ranges, so the sheet has no empty rows
  sheet.dataValidations.add(`E2:E${MAX_ROWS + 1}`, {
    type: 'list',
    allowBlank: true,
    formulae: ['"Each,Per kg,Per litre"'],
  });
  sheet.dataValidations.add(`J2:J${MAX_ROWS + 1}`, {
    type: 'list',
    allowBlank: true,
    formulae: ['"Yes,No"'],
  });

  const help = workbook.addWorksheet('How to fill');
  help.columns = [{ width: 18 }, { width: 110 }];
  TEMPLATE_HELP.forEach((row) => help.addRow(row));
  help.getRow(1).font = { bold: true };

  return workbook.xlsx.writeBuffer();
};

module.exports = {
  readProductSheet,
  buildProductTemplate,
};
