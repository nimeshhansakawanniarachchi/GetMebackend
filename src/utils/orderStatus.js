// =====================================================
// ORDER STATUSES (single source of truth for labels/groups)
// =====================================================

const ORDER_STATUS_LABELS = {
  pending_shopper_search: 'Placed',
  waiting_for_shopper: 'Finding shopper',
  shopper_accepted: 'Shopper assigned',
  shopping: 'Shopping',
  out_for_delivery: 'Out for delivery',
  arrived: 'Arrived',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  shopper_search_cancelled: 'Cancelled by customer',
};

const ORDER_STATUS_GROUPS = {
  active: ['pending_shopper_search', 'waiting_for_shopper', 'shopper_accepted', 'shopping'],
  delivery: ['out_for_delivery', 'arrived'],
  delivered: ['delivered'],
  cancelled: ['cancelled', 'shopper_search_cancelled'],
};

const FINISHED_STATUSES = [
  'delivered',
  ...ORDER_STATUS_GROUPS.cancelled,
];

const statusLabel = (status) =>
  ORDER_STATUS_LABELS[status] ||
  String(status || 'unknown').replace(/_/g, ' ');

module.exports = {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_GROUPS,
  FINISHED_STATUSES,
  statusLabel,
};
