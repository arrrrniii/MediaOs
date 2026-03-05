const config = require('../config');

function errorHandler(err, req, res, _next) {
  console.error('Unhandled error:', err.message);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'File too large',
      code: 'FILE_TOO_LARGE',
    });
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'File too large',
      code: 'FILE_TOO_LARGE',
    });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: 'Unexpected file field',
      code: 'UNEXPECTED_FIELD',
    });
  }

  const status = err.status || 500;
  const response = {
    error: status === 500 ? 'Internal server error' : err.message,
    code: err.code || 'INTERNAL_ERROR',
  };

  if (config.nodeEnv === 'development' && status === 500) {
    response.stack = err.stack;
  }

  res.status(status).json(response);
}

module.exports = errorHandler;
