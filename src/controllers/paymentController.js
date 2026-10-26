const pool = require('../config/db');

const gateway = require('../payments/payhere');
const payments = require('../payments/paymentService');
const { pendingRequestsBlock } = require('./orderItemRequestsController');

// =====================================================
// PAYMENTS API (/api/payments)
// Saved cards for customers and shoppers, the PayHere pages the
// apps open in a web view, PayHere's notify callback, order
// payment details and the shopper's store-bill payment.
// Card numbers and CVVs only ever go to PayHere's page.
// =====================================================

const ownerOf = (req) =>
  req.customer
    ? { type: 'customer', id: Number(req.customer.customerId) }
    : { type: 'shopper', id: Number(req.shopper?.shopperId ?? req.shopper?.id) };

const io = (req) => req.app.get('io');

const toId = (value) => {
  const id = Number(value);

  return Number.isInteger(id) && id > 0 ? id : null;
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

// Small mobile page shell for the web view
const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --ink:#1f2421; --muted:#6b726e; --brand:#0aad0a; --line:#e3e6e4; --bad:#c62828; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; background:#fff; color:var(--ink);
         font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  label { display:block; font-weight:600; font-size:14px; margin:14px 0 6px; }
  input { width:100%; height:48px; padding:0 12px; font-size:17px; border:1px solid var(--line); border-radius:10px; }
  .row { display:flex; gap:12px; } .row > div { flex:1; }
  button, .button { display:block; width:100%; height:52px; margin-top:22px; border:0; border-radius:26px;
           background:var(--brand); color:#fff; font-size:17px; font-weight:700; text-align:center;
           line-height:52px; text-decoration:none; }
  .link { display:block; text-align:center; margin-top:16px; color:var(--muted); }
  .note { background:#fff8e1; border-radius:10px; padding:12px; font-size:14px; color:#5d4a00; }
  .error { color:var(--bad); font-weight:600; }
  code { font-size:14px; }
</style>
</head>
<body>${body}</body>
</html>`;

const sendError = (res, error, fallback) => {
  const status = error?.status || 500;

  if (status >= 500) {
    console.error(`❌ ${fallback}:`, error?.message || error);
  }

  return res.status(status).json({
    success: false,
    message: status >= 500 && !error?.status ? fallback : error.message,
  });
};

// =====================================================
// GET /api/payments/config (public)
// Lets the apps label test mode
// =====================================================

const getConfig = (req, res) =>
  res.json({
    success: true,
    mode: gateway.getMode(),
    testMode: gateway.isTestMode(),
    available: !gateway.configProblem(),
    currency: gateway.CURRENCY,
  });

// =====================================================
// SAVED CARDS (customer + shopper)
// =====================================================

// GET /api/payments/{customer|shopper}/cards
const listCards = async (req, res) => {
  try {
    return res.json({ success: true, cards: await payments.listCards(ownerOf(req)) });
  } catch (error) {
    return sendError(res, error, 'Unable to load your cards');
  }
};

// POST /api/payments/{customer|shopper}/cards/setup
// -> { ref, checkoutUrl, returnUrl, cancelUrl } for the web view
const startCardSetup = async (req, res) => {
  const problem = gateway.configProblem();

  if (problem) {
    return res.status(503).json({ success: false, message: problem });
  }

  try {
    const ref = await payments.createCardSetup(ownerOf(req));
    const base = gateway.publicBaseUrl(req);

    return res.status(201).json({
      success: true,
      ref,
      testMode: gateway.isTestMode(),
      checkoutUrl: `${base}/api/payments/cards/checkout/${ref}`,
      returnUrl: `${base}/api/payments/cards/return`,
      cancelUrl: `${base}/api/payments/cards/cancel`,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to start adding a card');
  }
};

// GET /api/payments/{customer|shopper}/cards/setup/:ref
// The app polls this after the web view closes
const getCardSetupStatus = async (req, res) => {
  try {
    const owner = ownerOf(req);
    const setup = await payments.getCardSetup(req.params.ref);

    if (!setup || setup.owner_type !== owner.type || Number(setup.owner_id) !== owner.id) {
      return res.status(404).json({ success: false, message: 'Card setup not found' });
    }

    const card = setup.saved_card_id
      ? (await payments.listCards(owner)).find((item) => item.id === Number(setup.saved_card_id))
      : null;

    return res.json({
      success: true,
      status: setup.status,
      message: setup.status_message,
      card: card || null,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to check the card');
  }
};

// PATCH /api/payments/{customer|shopper}/cards/:cardId/default
const makeDefaultCard = async (req, res) => {
  try {
    const owner = ownerOf(req);
    const ok = await payments.setDefaultCard(owner, toId(req.params.cardId), io(req));

    if (!ok) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    return res.json({ success: true, cards: await payments.listCards(owner) });
  } catch (error) {
    return sendError(res, error, 'Unable to update the card');
  }
};

// DELETE /api/payments/{customer|shopper}/cards/:cardId
const deleteCard = async (req, res) => {
  try {
    const owner = ownerOf(req);
    const ok = await payments.removeCard(owner, toId(req.params.cardId), io(req));

    if (!ok) {
      return res.status(404).json({ success: false, message: 'Card not found' });
    }

    return res.json({
      success: true,
      message: 'Card removed',
      cards: await payments.listCards(owner),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to remove the card');
  }
};

// =====================================================
// PAYHERE PAGES (public; the setup ref is the one-time key)
// =====================================================

// GET /api/payments/cards/checkout/:ref
// Auto-submits PayHere's preapproval form (the card is typed on
// PayHere's page, never ours)
const cardCheckoutPage = async (req, res) => {
  try {
    const setup = await payments.getCardSetup(req.params.ref);

    if (!setup || setup.status !== 'pending') {
      return res
        .status(404)
        .send(page('Link expired', '<h1>This link has expired</h1><p>Go back to the app and try again.</p>'));
    }

    if (Date.now() - new Date(setup.created_at).getTime() > 30 * 60 * 1000) {
      await payments.finishSetup(setup.ref, 'cancelled', 'Expired');

      return res
        .status(410)
        .send(page('Link expired', '<h1>This link has expired</h1><p>Go back to the app and try again.</p>'));
    }

    const form = gateway.preapprovalForm({
      ref: setup.ref,
      payer: await payments.getPayer({ type: setup.owner_type, id: setup.owner_id }),
      baseUrl: gateway.publicBaseUrl(req),
    });

    const inputs = Object.entries(form.fields)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join('');

    return res.send(
      page(
        'Add a card',
        `<h1>Opening secure card page…</h1>
         <p>Your card details are entered on PayHere's secure page.</p>
         <form id="pay" method="post" action="${escapeHtml(form.action)}">${inputs}
           <button type="submit">Continue</button>
         </form>
         <script>document.getElementById('pay').submit();</script>`
      )
    );
  } catch (error) {
    console.error('❌ CARD CHECKOUT PAGE ERROR:', error.message);

    return res.status(500).send(page('Error', '<h1>Something went wrong</h1><p>Go back to the app and try again.</p>'));
  }
};

// GET /api/payments/cards/return?ref=  (PayHere return_url)
// The app's web view closes when it reaches this URL
const cardReturnPage = (req, res) =>
  res.send(
    page(
      'Card added',
      '<h1>Finishing up…</h1><p>You can return to the app.</p>'
    )
  );

// GET /api/payments/cards/cancel?ref=  (PayHere cancel_url)
const cardCancelPage = async (req, res) => {
  try {
    if (payments.isCardSetupRef(req.query.ref)) {
      await payments.finishSetup(String(req.query.ref), 'cancelled', 'Cancelled');
    }
  } catch (error) {
    console.error('❌ CARD CANCEL ERROR:', error.message);
  }

  return res.send(page('Cancelled', '<h1>No card was added</h1><p>You can return to the app.</p>'));
};

// =====================================================
// POST /api/payments/payhere/notify (PayHere server -> us)
// Verified with md5sig; answers 200 so PayHere stops retrying.
// =====================================================

const payhereNotify = async (req, res) => {
  const body = req.body || {};

  if (!gateway.verifyNotify(body)) {
    console.error('❌ PAYHERE NOTIFY: bad signature for', body.order_id);
    return res.status(400).send('invalid');
  }

  try {
    const ref = String(body.order_id || '');

    if (payments.isCardSetupRef(ref)) {
      if (String(body.status_code) === '2' && body.customer_token) {
        await payments.completeCardSetup(
          {
            ref,
            token: body.customer_token,
            brand: body.method,
            last4: body.card_no,
            holderName: body.card_holder_name,
            expiry: body.card_expiry,
          },
          io(req)
        );
      } else {
        await payments.finishSetup(
          ref,
          String(body.status_code) === '-1' ? 'cancelled' : 'failed',
          String(body.status_message || 'Card was not approved').slice(0, 300)
        );
      }
    } else if (payments.isPaymentRef(ref)) {
      await payments.handlePaymentNotify(body, io(req));
    }
  } catch (error) {
    console.error('❌ PAYHERE NOTIFY ERROR:', error.message);
    return res.status(500).send('error');
  }

  return res.send('ok');
};

// =====================================================
// TEST MODE: stand-in for PayHere's card page
// Only exists when PAYHERE_MODE is test (never in production).
// =====================================================

const testCardsList = () =>
  Object.entries(gateway.TEST_CARDS)
    .map(([number, card]) =>
      `<div><code>${number.replace(/(\d{4})(?=\d)/g, '$1 ')}</code> ${card.brand === 'MASTER' ? 'Mastercard' : 'Visa'}${card.outcome === 'decline' ? ' (payments decline)' : ''}</div>`
    )
    .join('');

const testGatewayForm = (ref, error, values = {}) =>
  page(
    'Test card page',
    `<h1>Add a card</h1>
     <div class="note"><b>Test mode</b> - this page stands in for PayHere. No real money moves.
     Use a test card, any future expiry and any 3-digit CVV:${testCardsList()}</div>
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
     <form method="post" action="/api/payments/test-gateway/preapprove" autocomplete="off">
       <input type="hidden" name="order_id" value="${escapeHtml(ref)}">
       <label for="number">Card number</label>
       <input id="number" name="number" inputmode="numeric" value="${escapeHtml(values.number)}" placeholder="4916 2175 0161 1292">
       <div class="row">
         <div><label for="expiry">Expiry</label>
           <input id="expiry" name="expiry" value="${escapeHtml(values.expiry)}" placeholder="MM/YY"></div>
         <div><label for="cvv">CVV</label>
           <input id="cvv" name="cvv" inputmode="numeric" maxlength="3" placeholder="123"></div>
       </div>
       <label for="name">Name on card</label>
       <input id="name" name="name" value="${escapeHtml(values.name)}" placeholder="Name on card">
       <button type="submit">Save card</button>
     </form>
     <a class="link" href="/api/payments/cards/cancel?ref=${encodeURIComponent(ref)}">Cancel</a>`
  );

const testGatewayPage = async (req, res) => {
  if (!gateway.isTestMode()) {
    return res.status(404).send('Not found');
  }

  const ref = String(req.body?.order_id || req.query?.order_id || '');
  const setup = payments.isCardSetupRef(ref) ? await payments.getCardSetup(ref) : null;

  if (!setup || setup.status !== 'pending' || setup.gateway !== 'test') {
    return res.status(404).send(page('Link expired', '<h1>This link has expired</h1><p>Go back to the app and try again.</p>'));
  }

  // First visit: the auto-submitted checkout form (no card yet)
  if (!req.body?.number) {
    return res.send(testGatewayForm(ref));
  }

  const card = gateway.testCardToken({
    number: req.body.number,
    expiry: req.body.expiry,
    cvv: req.body.cvv,
  });

  if (card.error) {
    return res.status(400).send(
      testGatewayForm(ref, card.error, { number: req.body.number, expiry: req.body.expiry, name: req.body.name })
    );
  }

  try {
    await payments.completeCardSetup(
      {
        ref,
        token: card.token,
        brand: card.brand,
        last4: card.last4,
        holderName: String(req.body.name || '').trim(),
        expiry: card.expiry,
      },
      io(req)
    );
  } catch (error) {
    console.error('❌ TEST GATEWAY SAVE ERROR:', error.message);
    return res.status(500).send(testGatewayForm(ref, 'Could not save the card'));
  }

  // Same redirect PayHere does (built here, not taken from the form)
  return res.redirect(303, `/api/payments/cards/return?ref=${encodeURIComponent(ref)}`);
};

// =====================================================
// GET /api/payments/customer/orders/:orderId
// Payment status + transactions for the customer's order
// =====================================================

const getCustomerOrderPayment = async (req, res) => {
  const orderId = toId(req.params.orderId);

  if (!orderId) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  try {
    const order = (
      await pool.query('SELECT * FROM orders WHERE id = $1 AND customer_id = $2 LIMIT 1', [
        orderId,
        Number(req.customer.customerId),
      ])
    ).rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    return res.json({ success: true, payment: await payments.orderPaymentSummary(order) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the payment');
  }
};

// =====================================================
// SHOPPER: PAY A STORE'S BILL WITH A SAVED CARD
// GET  /api/payments/shopper/orders/:orderId/store-bill?shopId=
// POST /api/payments/shopper/orders/:orderId/store-bill
//      { shopId, cardId, amount }
// amount is the checkout total the shopper saw; it may not be more
// than the shop's items allow (same rules as the app's line totals).
// =====================================================

const WEIGHT_FACTORS = { g: 0.001, ml: 0.001, kg: 1, l: 1 };

// Most a shop's bill can be for this order
const maxStoreBill = (items) =>
  payments.round2(
    items.reduce((sum, item) => {
      if (String(item.shopping_status || '').toLowerCase() === 'refunded') {
        return sum;
      }

      const unitPrice = Number(item.unit_price);
      const foundWeight = Number(item.found_weight);

      if (foundWeight > 0 && Number.isFinite(unitPrice)) {
        const factor = WEIGHT_FACTORS[String(item.found_weight_unit || 'kg').toLowerCase()] ?? 1;
        return sum + unitPrice * foundWeight * factor;
      }

      const pack = Math.max(
        Number(item.price) || 0,
        Number(item.replacement_product_price) || 0,
        Number(item.unit_price) || 0
      );

      const quantity = Math.max(Number(item.found_quantity) || 0, Number(item.quantity) || 0, 1);

      return sum + pack * quantity;
    }, 0)
  );

const findShopperOrderShop = async (orderId, shopperId, shopId) =>
  (
    await pool.query(
      `
      SELECT o.id, o.status, o.customer_id, s.shop_name
      FROM orders o
      INNER JOIN order_shops os ON os.order_id = o.id AND os.shop_id = $3
      LEFT JOIN shops s ON s.id = os.shop_id
      WHERE o.id = $1 AND o.shopper_id = $2
      LIMIT 1
      `,
      [orderId, shopperId, shopId]
    )
  ).rows[0] || null;

const getStoreBillPayment = async (req, res) => {
  const owner = ownerOf(req);
  const orderId = toId(req.params.orderId);
  const shopId = toId(req.query.shopId);

  if (!orderId || !shopId) {
    return res.status(400).json({ success: false, message: 'Order and shop are required' });
  }

  try {
    if (!(await findShopperOrderShop(orderId, owner.id, shopId))) {
      return res.status(404).json({ success: false, message: 'Order not found for this shopper' });
    }

    return res.json({ success: true, payment: await payments.storeBillPayment(orderId, shopId) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the payment');
  }
};

const payStoreBill = async (req, res) => {
  const owner = ownerOf(req);
  const orderId = toId(req.params.orderId);
  const shopId = toId(req.body?.shopId);
  const cardId = toId(req.body?.cardId);
  const amount = payments.round2(req.body?.amount);

  if (!orderId || !shopId) {
    return res.status(400).json({ success: false, message: 'Order and shop are required' });
  }

  if (!cardId) {
    return res.status(400).json({ success: false, message: 'Choose a saved card to pay with' });
  }

  if (!(amount > 0)) {
    return res.status(400).json({ success: false, message: 'There is nothing to pay for this store' });
  }

  try {
    const order = await findShopperOrderShop(orderId, owner.id, shopId);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found for this shopper' });
    }

    if (['cancelled', 'delivered', 'completed'].includes(order.status)) {
      return res.status(409).json({ success: false, message: 'This order is already finished' });
    }

    // Extra item requests for this shop must be answered first
    const pendingBlock = await pendingRequestsBlock(orderId, shopId);

    if (pendingBlock) {
      return res.status(409).json(pendingBlock);
    }

    // Paid already (double tap, or back from the bill photo)
    const existing = await payments.storeBillPayment(orderId, shopId);

    if (existing && existing.status === 'paid') {
      return res.json({ success: true, alreadyPaid: true, payment: existing });
    }

    const items = (
      await pool.query('SELECT * FROM order_items WHERE order_id = $1 AND shop_id = $2', [orderId, shopId])
    ).rows;

    const limit = maxStoreBill(items);

    if (amount > limit + 0.009) {
      return res.status(400).json({
        success: false,
        message: `The bill can't be more than Rs ${limit.toFixed(2)} for these items`,
      });
    }

    let row;

    try {
      row = await payments.chargeSavedCard({
        owner,
        cardId,
        amount,
        purpose: 'store_bill',
        orderId,
        shopId,
        items: `GetMe order #${orderId} - ${order.shop_name || 'store'} bill`,
        baseUrl: gateway.publicBaseUrl(req),
        io: io(req),
      });
    } catch (error) {
      // Unique index: a second charge raced this one
      if (error.code === '23505') {
        return res.status(409).json({ success: false, message: 'This bill is already being paid' });
      }

      throw error;
    }

    if (row.status !== 'paid') {
      return res.status(402).json({
        success: false,
        code: 'CARD_DECLINED',
        message: payments.declineMessage(row),
        payment: payments.toPublicPayment(row),
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Payment successful',
      payment: payments.toPublicPayment(row),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to pay the bill');
  }
};

module.exports = {
  getConfig,
  listCards,
  startCardSetup,
  getCardSetupStatus,
  makeDefaultCard,
  deleteCard,
  cardCheckoutPage,
  cardReturnPage,
  cardCancelPage,
  payhereNotify,
  testGatewayPage,
  getCustomerOrderPayment,
  getStoreBillPayment,
  payStoreBill,
};
