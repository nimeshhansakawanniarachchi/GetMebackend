# GetMe Web API (Admin panel + Shop website)

Base URL: `VITE_API_URL` (dev: `http://localhost:5000`). All responses are JSON with `success: boolean`; errors have `message` (show it to the user). Images/bills are relative paths like `/uploads/products/x.jpg` → prefix with the base URL.

Auth: `Authorization: Bearer <token>`. `401` → token missing/expired → log out and go to `/login`. `403` → logged in but not allowed (show message). `429` on login → too many attempts (show message).

Paginated lists return `{ page, pageSize, total, totalPages, ... }` and accept `?page=&pageSize=` (max 100).

Order statuses (raw → label): `pending_shopper_search` Placed · `waiting_for_shopper` Finding shopper · `shopper_accepted` Shopper assigned · `shopping` Shopping · `out_for_delivery` Out for delivery · `arrived` Arrived · `delivered` Delivered · `cancelled` Cancelled · `shopper_search_cancelled` Cancelled by customer. Lists already include `statusLabel`.
Status filter groups (`?status=`): `active`, `delivery`, `delivered`, `cancelled`.

## Real-time (socket.io-client, same base URL)
`io(BASE_URL, { auth: { token } })`. Server puts admins in room `admins` and shops in `shop:{id}` automatically.
- Admin events: `admin:order-updated` `{ orderId, event, status }`, `admin:shoppers-updated` `{ shopperId, reason }`, `admin:shops-updated` `{ shopId, reason }`.
- Shop events: `shop:new-order` `{ orderId }`, `shop:order-updated` `{ orderId, event, status }`, `shop:status-changed` `{ status }` (admin approved/suspended the shop).
Use events to refetch the current view (debounce ~500 ms). No polling.

---

## Admin API — `/api/admin`
Every route except login needs an admin token.

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `{ token, admin }` (token valid 12h) |
| GET | `/auth/me` | | `{ admin: { id, fullName, email, isActive, lastLoginAt, createdAt } }` |
| PUT | `/auth/password` | `{ currentPassword, newPassword }` (min 8) | `{ message }` |
| GET | `/admins` | | `{ admins: [admin] }` |
| POST | `/admins` | `{ fullName, email, password }` | `{ admin }` (409 if email exists) |
| PATCH | `/admins/:id` | `{ isActive: boolean }` | `{ admin }` (can't deactivate self) |
| GET | `/dashboard` | | `{ stats: { salesToday, ordersToday, activeOrders, totalCustomers, onlineShoppers, liveShops }, pendingApprovals: { shops, shoppers, total }, salesLast7Days: [{ date, sales, orders }], ordersByStatus: [{ status, label, count }], recentOrders: [{ id, status, statusLabel, customerName, shopNames, totalAmount, createdAt }] }` |
| GET | `/orders` | `status, from, to (YYYY-MM-DD), search (order #, customer name/phone, shopper, shop), page` | `{ orders: [{ id, status, statusLabel, customerName, customerMobile, shopperName, shopNames, itemCount, totalAmount, paymentMethod, paymentStatus, deliveryOption, createdAt, deliveredAt }] }` |
| GET | `/orders/:id` | | `{ order }` — see below |
| PATCH | `/orders/:id/cancel` | `{ reason }` (min 3 chars) | `{ message }` (409 if already finished) |
| GET | `/customers` | `search, page` | `{ customers: [{ id, fullName, mobile, email, orderCount, totalSpent, lastOrderAt, createdAt }] }` |
| GET | `/customers/:id` | | `{ customer: { id, fullName, mobile, email, createdAt, orderCount, totalSpent }, addresses: [{ id, label, address }], orders: [{ id, status, statusLabel, shopNames, totalAmount, createdAt }] }` |
| GET | `/shoppers` | `approval=pending\|approved\|rejected\|suspended, online=true, search, page` | `{ shoppers: [{ id, fullName, mobile, email, online, approvalStatus, vehicleType, vehicleNumber, latitude, longitude, deliveries, earnings, activeJobs, createdAt, lastSeenAt }] }` (pending first) |
| PATCH | `/shoppers/:id/approval` | `{ approvalStatus: approved\|rejected\|suspended\|pending }` | `{ shopper: { id, approvalStatus, online } }` (non-approved → forced offline) |
| GET | `/shops` | `status=pending\|approved\|rejected\|suspended, search, page` | `{ shops: [{ id, shopName, email, mobile, address, area, status, isOpen, imageUrl, brandColor, latitude, longitude, productCount, orderCount, sales, createdAt }] }` (pending first; `brandColor` is `"#RRGGBB"` or null) |
| PATCH | `/shops/:id/status` | `{ status: approved\|rejected\|suspended\|pending }` | `{ shop: { id, status } }` |
| PATCH | `/shops/:id/brand-color` | `{ brandColor: "#RRGGBB" \| "#RGB" \| null }` | `{ shop: { id, brandColor } }`; null clears it (the customer app picks a color). `400` if it isn't a hex color or is too light for white text (needs 3:1 contrast with white) |
| GET | `/products` | `shopId, category, availability=available\|unavailable, search, page (default 25)` | `{ categories: [string], products: [{ id, shopId, shopName, productName, category, price, stockQuantity, isAvailable, imageUrl, createdAt }] }` |
| PATCH | `/products/:id/availability` | `{ isAvailable: boolean }` | `{ product: { id, isAvailable } }` |
| GET | `/payments` | `method, paymentStatus, page` | `{ summary: { collected, cash, nonCash, shopperPay, serviceFees }, payments: [{ orderId, status, statusLabel, customerName, shopperName, method, paymentStatus, reference, paidAt, itemsTotal, actualItemsTotal, deliveryFee, fastDeliveryFee, serviceFee, totalAmount, shopperPay, reimbursementStatus, reimbursementAmount, billCount, createdAt }] }` |
| GET | `/reports` | `days=7\|30\|90` | `{ days, totals: { orders, delivered, cancelled, sales, averageOrder, customers, completionRate (0-1) }, daily: [{ date, sales, orders }], topShops: [{ id, shopName, orders, sales }], topProducts: [{ name, quantity, sales }], ordersByStatus: [{ status, label, count }] }` |

`GET /orders/:id` → `order`:
```
{ id, status, statusLabel, canCancel, cancelledBy, cancelReason, createdAt, updatedAt,
  customer: { id, name, mobile, email },
  shopper: { id, name, mobile, vehicleType, vehicleNumber } | null,
  delivery: { address, latitude, longitude, option, distanceKm, scheduledDate, scheduledStartTime, scheduledEndTime },
  money: { itemsTotal, actualItemsTotal, deliveryFee, fastDeliveryFee, serviceFee, totalAmount, shopperPay },
  payment: { method, status, reference, paidAt, reimbursementStatus, reimbursementAmount, reimbursedAt },
  shops: [{ id, name, imageUrl, address, mobile,
            bill: { url, uploadedAt, status } | null,
            items: [{ id, name, quantity, unit, price, lineTotal, custom, details, image, voiceUrl,
                      shoppingStatus, foundQuantity, foundWeight, foundWeightUnit, shopperPhotoUrl,
                      replacements: [{ id, optionNumber, photoUrl, status, createdAt }] }] }],
  timeline: [{ label, at }],
  chat: [{ id, senderType: 'customer'|'shopper', message, createdAt }] }
```

---

## Shop API — `/api/shop`
Every route except register/login needs a shop token. Shop `status`: `pending` (can set up store, hidden from customers — show an "Awaiting GetMe approval" banner), `approved`, `rejected`/`suspended` (login and all calls return 403 with a message).

Shop object: `{ id, shopName, email, mobile, address, area, latitude, longitude, status, isOpen, imageUrl, brandColor, createdAt, updatedAt }` (`brandColor` is `"#RRGGBB"` or null = automatic)
Product object: `{ id, shopId, productName, category, price, stockQuantity, description, imageUrl, isAvailable, createdAt, updatedAt }`

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/register` | JSON `{ shopName, email, mobile, password (min 8), address?, latitude?, longitude? }` | `201 { message, token, shop }` (status `pending`) |
| POST | `/login` | `{ email, password }` | `{ token, shop }` |
| GET | `/me` | | `{ shop }` |
| PUT | `/profile` | multipart: `shopName, mobile, address, latitude, longitude, image?` (jpg/png/webp ≤5MB), `brandColor?` (`#RRGGBB` sets, `""` clears, omitted keeps) | `{ shop }`; `400` if `brandColor` isn't a hex color or is too light for white text |
| PATCH | `/open` | `{ isOpen: boolean }` | `{ shop }` (closed = hidden from customers, no new orders) |
| GET | `/dashboard` | | `{ stats: { ordersToday, activeOrders, salesToday, salesThisWeek, totalProducts, liveProducts, unavailableProducts, lowStockProducts }, recentOrders: [{ id, status, statusLabel, customerName, itemCount, shopTotal, createdAt }] }` |
| GET | `/orders` | `status=active\|delivery\|delivered\|cancelled, page` | `{ orders: [{ id, status, statusLabel, customerName (first name), shopperName, deliveryOption, itemCount, shopTotal, hasBill, createdAt, deliveredAt }] }` |
| GET | `/orders/:id` | | `{ order: { id, status, statusLabel, customerName, deliveryOption, scheduledDate, scheduledStartTime, scheduledEndTime, createdAt, updatedAt, deliveredAt, shopper: { name, mobile, vehicleType, vehicleNumber } \| null, items: [{ id, productId, name, quantity, unit, price, lineTotal, custom, details, image, shoppingStatus, foundQuantity, foundWeight, foundWeightUnit, shopperPhotoUrl, replacements: [{ id, optionNumber, photoUrl, status }] }], shopTotal, bill: { url, uploadedAt, status } \| null } }` (only this shop's items) |
| GET | `/products` | | `{ products: [product] }` |
| GET | `/products/:id` | | `{ product }` |
| POST | `/products` | multipart: `productName, category, price, stockQuantity (int ≥0), description?, isAvailable ('true'/'false'), unit?, barcode?, brand?, size?, image?` | `201 { product }`; `409 { code: 'duplicate_barcode', productId }` if the shop already lists the barcode. An 8/12/13-digit number with a wrong EAN/UPC check digit is saved as a shop-only code (warn the user; the form does); manufacturer codes link the product to the shared catalogue (`product.catalogId`) and reuse its image when none is uploaded |
| PUT | `/products/:id` | same multipart as POST (image optional; omitted keeps current) | `{ product }` |
| PATCH | `/products/:id` | JSON `{ isAvailable?: boolean, stockQuantity?: int }` | `{ product }` (quick toggle / stock edit) |
| GET | `/products/import/template` | | `.xlsx` download: columns `Product name *, Category *, Price (Rs) *, Stock *, Sold as (Each/Per kg/Per litre), Barcode (text), Brand, Size, Description, Available (Yes/No)` plus a "How to fill" sheet |
| POST | `/products/import` | multipart: `file` (.xlsx or .csv, ≤20MB, ≤2000 rows; JPG/PNG/WEBP pictures placed in (Excel 365 "Place in Cell", WPS `DISPIMG` cell images) or over a `Photo` / `Product Image` cell become that row's photo, `product.hasPhoto`), `mode` (`preview` checks only, `import` saves), `updateExisting` (`'true'` updates matches, otherwise they are skipped) | `{ imported, summary: { total, create\|created, update\|updated, skip, error }, rows: [{ row, status: create\|update\|created\|updated\|skip\|error, message, product: { productName, category, price, stockQuantity, unit, barcode } }] }`; `400 { message }` if the file can't be read or has no heading row. Rows are validated like POST `/products`. Existing products match by barcode (UPC-A/EAN-13 forms alike), or by name when the row has no barcode; updates replace price/stock and keep fields left blank. New products with a manufacturer barcode get the catalogue image. Headings are matched loosely, so exports from other systems (e.g. UltimatePOS `NAME`, `SELLING PRICE`, `OPENING STOCK`) also work |
| GET | `/catalog/:barcode` | | `{ validCheckDigit, shopProduct: { id, productName } | null, catalogProduct: { id, barcode, productName, brand, size, category, imageUrl } | null }` — after a scan: already listed by this shop? known to the shared catalogue? |
| DELETE | `/products/:id` | | `{ hidden: boolean, message }` — products used in past orders are hidden instead of deleted (show the message) |

Item `shoppingStatus` values seen: `pending`, `found`/`done`, `unavailable`, `replaced`, `waiting_customer` (display generically: unknown → title-case).
