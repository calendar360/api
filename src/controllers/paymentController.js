import crypto from 'crypto';
import axios from 'axios';
import pool from '../db/pool.js';

const MARQUEE_PRICE_PER_DAY = 0.99;
const MARQUEE_CENTS_PER_DAY = 99;
const PREMIUM_PRICE = 2.99;
const PREMIUM_PRICE_CENTS = 299;

function backendBaseUrl(req) {
  const env = process.env.BACKEND_URL;
  if (env) return env.replace(/\/api\/?$/, '').replace(/\/$/, '');
  const host = req.get('host');
  const proto = req.protocol || 'http';
  return `${proto}://${host}`;
}

function extractPaymentId(data) {
  if (!data) return null;
  return (
    data.payment_id ||
    data.paymentId ||
    data.productid ||
    data.product_id ||
    data.data?.payment_id ||
    null
  );
}

export const initMarqueeAdPayment = async (req, res) => {
  try {
    const { adId } = req.body;
    if (!adId) {
      return res.status(400).json({ success: false, message: 'adId required' });
    }

    const adRes = await pool.query(
      `SELECT * FROM advertisements WHERE id = $1 AND user_id = $2`,
      [adId, req.userId],
    );
    if (!adRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Advert not found' });
    }
    const ad = adRes.rows[0];
    if (ad.status === 'active') {
      return res.status(400).json({ success: false, message: 'Advert already active' });
    }

    const baseUrl = backendBaseUrl(req);
    const success_url = `${baseUrl}/api/payments/espees/success?adId=${encodeURIComponent(adId)}`;
    const fail_url = `${baseUrl}/api/payments/espees/failed?adId=${encodeURIComponent(adId)}`;

    const amountCents = ad.amount_cents || MARQUEE_CENTS_PER_DAY;
    const price = amountCents / 100;
    const days = ad.duration_days || Math.max(1, Math.round(amountCents / MARQUEE_CENTS_PER_DAY));

    const payload = {
      product_sku: `marquee_ad_${adId}`,
      price,
      merchant_wallet: process.env.ESPEES_MERCHANT_WALLET || process.env.ESPEES_WALLET,
      narration: `Marquee advert: ${ad.title} (${days} day${days === 1 ? '' : 's'})`,
      success_url,
      fail_url,
    };

    if (!payload.merchant_wallet) {
      return res.status(500).json({
        success: false,
        message: 'ESPEES_MERCHANT_WALLET not configured on server',
      });
    }

    const response = await axios.post('https://api.espees.org/payment/product', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    const respData = response.data || {};
    const payment_id = extractPaymentId(respData);
    if (!payment_id) {
      return res.status(502).json({
        success: false,
        message: 'Espees did not return a payment id',
        details: respData,
      });
    }

    const payment = {
      payment_id,
      status: 'Initialized',
      amount: price,
      durationDays: days,
      createdAt: new Date().toISOString(),
    };

    await pool.query(
      `UPDATE advertisements SET payment_id = $1, payment = $2 WHERE id = $3`,
      [payment_id, JSON.stringify(payment), adId],
    );

    return res.json({
      success: true,
      payment_url: `https://payment.espees.org/pay/${payment_id}`,
      payment_id,
      adId,
      amount: price,
      durationDays: days,
    });
  } catch (err) {
    console.error('initMarqueeAdPayment', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Payment init failed',
      details: err.response?.data || err.message,
    });
  }
};

async function activateMarqueeAd(adId, confirmData = {}) {
  const adRes = await pool.query('SELECT * FROM advertisements WHERE id = $1', [adId]);
  const ad = adRes.rows[0];
  const start = new Date();
  const end =
    ad?.end_at != null
      ? new Date(ad.end_at)
      : new Date(start.getTime() + (ad?.duration_days || 1) * 24 * 60 * 60 * 1000);
  const payment = {
    status: 'Paid',
    confirmedAt: new Date().toISOString(),
    confirmation: confirmData,
  };
  await pool.query(
    `UPDATE advertisements SET
      status = 'active',
      start_at = $1,
      end_at = $2,
      payment = $3
     WHERE id = $4`,
    [start.toISOString(), end.toISOString(), JSON.stringify(payment), adId],
  );
}

export const initPremiumPayment = async (req, res) => {
  try {
    const baseUrl = backendBaseUrl(req);
    const success_url = `${baseUrl}/api/payments/premium/success`;
    const fail_url = `${baseUrl}/api/payments/premium/failed`;

    const payload = {
      product_sku: `premium_subscription_${req.userId}`,
      price: PREMIUM_PRICE,
      merchant_wallet: process.env.ESPEES_MERCHANT_WALLET || process.env.ESPEES_WALLET,
      narration: `Calendar 360 Premium Subscription`,
      success_url,
      fail_url,
    };

    if (!payload.merchant_wallet) {
      return res.status(500).json({
        success: false,
        message: 'ESPEES_MERCHANT_WALLET not configured on server',
      });
    }

    const response = await axios.post('https://api.espees.org/payment/product', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    const respData = response.data || {};
    const payment_id = extractPaymentId(respData);
    if (!payment_id) {
      return res.status(502).json({
        success: false,
        message: 'Espees did not return a payment id',
        details: respData,
      });
    }

    return res.json({
      success: true,
      payment_url: `https://payment.espees.org/pay/${payment_id}`,
      payment_id,
      amount: PREMIUM_PRICE,
    });
  } catch (err) {
    console.error('initPremiumPayment', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Payment init failed',
      details: err.response?.data || err.message,
    });
  }
};

export const handleEspeesSuccess = async (req, res) => {
  try {
    const adId = req.query.adId;
    const transaction_id =
      req.query.transaction_id || req.query.payment_id || req.query.product_id;

    if (!adId) {
      return res.status(400).send(paymentHtml(false, 'Missing advert id'));
    }

    const adRes = await pool.query('SELECT * FROM advertisements WHERE id = $1', [adId]);
    if (!adRes.rows.length) {
      return res.status(404).send(paymentHtml(false, 'Advert not found'));
    }
    const ad = adRes.rows[0];

    let payment = {};
    try {
      payment = typeof ad.payment === 'string' ? JSON.parse(ad.payment) : ad.payment || {};
    } catch (_) {}

    if (ad.status === 'active' && payment.status === 'Paid') {
      return res.send(paymentHtml(true, 'Payment already confirmed'));
    }

    let confirmData = {};
    const productId = transaction_id || ad.payment_id;
    if (productId) {
      try {
        const confirmResp = await axios.post(
          'https://api.espees.org/payment/confirm',
          { product_id: productId },
          { headers: { 'Content-Type': 'application/json' }, timeout: 20000 },
        );
        confirmData = confirmResp.data || {};
        const returnedAmount = confirmData?.price ?? confirmData?.amount;
        const expectedPrice = (ad.amount_cents || MARQUEE_CENTS_PER_DAY) / 100;
        if (returnedAmount != null && parseFloat(returnedAmount) !== expectedPrice) {
          await pool.query(
            `UPDATE advertisements SET payment = $1, status = 'pending_review' WHERE id = $2`,
            [
              JSON.stringify({
                ...payment,
                status: 'Discrepancy',
                confirmation: confirmData,
              }),
              adId,
            ],
          );
          return res.send(paymentHtml(false, 'Amount mismatch — contact support'));
        }
      } catch (confirmErr) {
        console.error('[espees] confirm', confirmErr.message);
      }
    }

    await activateMarqueeAd(adId, confirmData);
    const days = ad.duration_days || 1;
    return res.send(
      paymentHtml(true, `Marquee advert is now live for ${days} day${days === 1 ? '' : 's'}`),
    );
  } catch (err) {
    console.error('handleEspeesSuccess', err);
    return res.status(500).send(paymentHtml(false, 'Server error'));
  }
};

export const handleEspeesFailure = async (req, res) => {
  try {
    const adId = req.query.adId;
    if (adId) {
      await pool.query(
        `UPDATE advertisements SET status = 'payment_failed' WHERE id = $1 AND status != 'active'`,
        [adId],
      );
    }
    const details = req.query.status_details || 'Payment was not completed';
    return res.send(paymentHtml(false, details));
  } catch (err) {
    console.error('handleEspeesFailure', err);
    return res.status(500).send(paymentHtml(false, 'Payment failed'));
  }
};

export const getAdPaymentStatus = async (req, res) => {
  try {
    const { adId } = req.params;
    const result = await pool.query(
      `SELECT id, status, payment_id, payment, amount_cents, start_at, end_at
       FROM advertisements WHERE id = $1 AND user_id = $2`,
      [adId, req.userId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    const row = result.rows[0];
    let payment = {};
    try {
      payment = typeof row.payment === 'string' ? JSON.parse(row.payment) : row.payment || {};
    } catch (_) {}
    return res.json({
      success: true,
      adId: row.id,
      status: row.status,
      paid: row.status === 'active' || payment.status === 'Paid',
      payment,
      amountCents: row.amount_cents,
    });
  } catch (err) {
    console.error('getAdPaymentStatus', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const handleEspeesWebhook = async (req, res) => {
  try {
    const sigHeader =
      req.headers[process.env.ESPEES_WEBHOOK_HEADER || 'x-espees-signature'] ||
      req.headers['x-espees-signature'] ||
      req.headers['x-signature'];
    const secret = process.env.ESPEES_WEBHOOK_SECRET;

    if (secret) {
      if (!sigHeader) {
        return res.status(401).json({ received: true, message: 'Missing signature' });
      }
      const raw = req.rawBody || JSON.stringify(req.body);
      const computed = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      if (computed !== sigHeader) {
        return res.status(401).json({ received: true, message: 'Invalid signature' });
      }
    }

    const payload = req.body || {};
    const product_id =
      payload.product_id ||
      payload.transaction_id ||
      payload.payment_id ||
      payload.productId ||
      payload.id;
    const status =
      payload.status || payload.payment_status || payload.state || payload.result;

    if (!product_id) {
      return res.status(400).json({ received: true, message: 'Missing product_id' });
    }

    const adRes = await pool.query('SELECT * FROM advertisements WHERE payment_id = $1', [
      product_id,
    ]);
    if (!adRes.rows.length) {
      return res.status(200).json({ received: true, message: 'Advert not found' });
    }
    const ad = adRes.rows[0];

    let payment = {};
    try {
      payment = typeof ad.payment === 'string' ? JSON.parse(ad.payment) : ad.payment || {};
    } catch (_) {}

    if (payment.status === 'Paid' || ad.status === 'active') {
      return res.status(200).json({ received: true });
    }

    const ok =
      String(status).toLowerCase().includes('success') ||
      String(status).toLowerCase().includes('paid') ||
      payload.success === true;

    if (ok) {
      await activateMarqueeAd(ad.id, payload);
      return res.status(200).json({ received: true });
    }

    await pool.query(
      `UPDATE advertisements SET status = 'payment_failed', payment = $1 WHERE id = $2`,
      [JSON.stringify({ ...payment, status: 'Failed', lastWebhook: payload }), ad.id],
    );
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('handleEspeesWebhook', err);
    return res.status(500).json({ received: false });
  }
};

function paymentHtml(success, message) {
  const color = success ? '#00b894' : '#e74c3c';
  const title = success ? 'Payment successful' : 'Payment failed';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title></head><body style="font-family:system-ui;text-align:center;padding:40px;background:#0f172a;color:#fff;">
<h1 style="color:${color}">${title}</h1><p>${message}</p><p style="opacity:0.7;font-size:14px;">You can close this page and return to Calendar 360.</p>
</body></html>`;
}

export const handlePremiumSuccess = async (req, res) => {
  try {
    const transaction_id = req.query.transaction_id || req.query.payment_id || req.query.product_id;

    if (!req.userId) {
      return res.status(400).send(paymentHtml(false, 'User not authenticated'));
    }

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!userRes.rows.length) {
      return res.status(404).send(paymentHtml(false, 'User not found'));
    }
    const user = userRes.rows[0];

    let premiumData = {};
    try {
      premiumData = typeof user.premium_data === 'string' ? JSON.parse(user.premium_data) : user.premium_data || {};
    } catch (_) {}

    if (premiumData.status === 'active' && premiumData.paid) {
      return res.send(paymentHtml(true, 'Premium already activated'));
    }

    let confirmData = {};
    if (transaction_id) {
      try {
        const confirmResp = await axios.post(
          'https://api.espees.org/payment/confirm',
          { product_id: transaction_id },
          { headers: { 'Content-Type': 'application/json' }, timeout: 20000 },
        );
        confirmData = confirmResp.data || {};
        const returnedAmount = confirmData?.price ?? confirmData?.amount;
        if (returnedAmount != null && parseFloat(returnedAmount) !== PREMIUM_PRICE) {
          await pool.query(
            `UPDATE users SET premium_data = $1 WHERE id = $2`,
            [
              JSON.stringify({
                ...premiumData,
                status: 'Discrepancy',
                confirmation: confirmData,
              }),
              req.userId,
            ],
          );
          return res.send(paymentHtml(false, 'Amount mismatch — contact support'));
        }
      } catch (confirmErr) {
        console.error('[espees] confirm', confirmErr.message);
      }
    }

    const activationDate = new Date();
    const expirationDate = new Date(activationDate.getTime() + 30 * 24 * 60 * 60 * 1000);

    const updatedData = {
      status: 'active',
      paid: true,
      activatedAt: activationDate.toISOString(),
      expiresAt: expirationDate.toISOString(),
      confirmation: confirmData,
    };

    await pool.query(
      `UPDATE users SET premium_data = $1 WHERE id = $2`,
      [JSON.stringify(updatedData), req.userId],
    );

    return res.send(paymentHtml(true, 'Premium subscription activated'));
  } catch (err) {
    console.error('handlePremiumSuccess', err);
    return res.status(500).send(paymentHtml(false, 'Server error'));
  }
};

export const handlePremiumFailure = async (req, res) => {
  try {
    if (req.userId) {
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
      if (userRes.rows.length) {
        const user = userRes.rows[0];
        let premiumData = {};
        try {
          premiumData = typeof user.premium_data === 'string' ? JSON.parse(user.premium_data) : user.premium_data || {};
        } catch (_) {}

        await pool.query(
          `UPDATE users SET premium_data = $1 WHERE id = $2`,
          [JSON.stringify({ ...premiumData, status: 'payment_failed' }), req.userId],
        );
      }
    }
    const details = req.query.status_details || 'Payment was not completed';
    return res.send(paymentHtml(false, details));
  } catch (err) {
    console.error('handlePremiumFailure', err);
    return res.status(500).send(paymentHtml(false, 'Payment failed'));
  }
};

