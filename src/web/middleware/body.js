'use strict';

// Request body limit (SEC-010): 16 KB JSON bodies, larger ones rejected with
// 413 BODY_TOO_LARGE by the error middleware.

const express = require('express');

function bodyLimit() {
  return express.json({ limit: '16kb' });
}

module.exports = { bodyLimit };
