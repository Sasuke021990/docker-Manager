'use strict';

// Static assets, manifest and service worker (design §11.3, NFR-052): hand-
// written files, no build step, correct content types.

const path = require('node:path');
const express = require('express');

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', 'public');

function assetsRouter() {
  const router = express.Router();

  router.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), {
    immutable: true,
    maxAge: '7d',
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=604800')
  }));
  router.use('/icons', express.static(path.join(PUBLIC_DIR, 'icons'), { maxAge: '7d' }));

  router.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
  });

  router.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });

  return router;
}

module.exports = { assetsRouter, PUBLIC_DIR };
