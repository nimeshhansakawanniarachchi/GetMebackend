// =====================================================
// PAGINATION: ?page=1&pageSize=20 (max 100)
// =====================================================

const readPage = (query, defaultSize = 20) => {
  const page = Math.max(1, Number.parseInt(query?.page, 10) || 1);

  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(query?.pageSize, 10) || defaultSize)
  );

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
};

const pageMeta = ({ page, pageSize }, total) => ({
  page,
  pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / pageSize)),
});

module.exports = {
  readPage,
  pageMeta,
};
