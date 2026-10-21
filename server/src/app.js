'use strict';
const path = require('path');
const express = require('express');
const { LoginLimiter } = require('./auth');
const clientRoutes = require('./routes/client');
const adminRoutes = require('./routes/admin');

function createApp(ctx) {
  ctx.limiter = ctx.limiter || new LoginLimiter();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', clientRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(
    '/admin',
    (req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
      );
      next();
    },
    express.static(path.join(__dirname, '..', 'public', 'admin'))
  );
  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

module.exports = { createApp };
