import crypto from 'crypto';
import axios from 'axios';
import pool from '../db/pool.js';
import { computeMeetingsAccess } from '../services/meetingsAccessService.js';
import {
  signedRefQuery,
  verifiedUserId,
  signedAdRefQuery,
  verifiedAdRef,
} from '../services/paymentRefService.js';
import { pushToAdmins } from '../services/fcmService.js';

const MARQUEE_CENTS_PER_HOUR = 99;
const MARQUEE_PRICE_PER_HOUR = MARQUEE_CENTS_PER_HOUR / 100;
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
    // Payment is only reachable once an admin has approved the advert. This is
    // what stops anyone paying their way past review — and, with the signed
    // callback below, what stops an advert going live without either.
    // 'pending_payment' is accepted only for drafts left over from the old
    // pay-first flow.
    if (ad.status !== 'approved_unpaid' && ad.status !== 'pending_payment') {
      return res.status(409).json({
        success: false,
        message:
          ad.status === 'pending_approval'
            ? 'This advert is still being reviewed. You will be notified when it is approved.'
            : `This advert cannot be paid for while it is "${ad.status}"`,
        status: ad.status,
      });
    }

    const baseUrl = backendBaseUrl(req);
    // Signed, so the advert id and the payer cannot be swapped or invented.
    const ref = signedAdRefQuery(req.userId, adId);
    const success_url = `${baseUrl}/api/payments/espees/success?${ref}`;
    const fail_url = `${baseUrl}/api/payments/espees/failed?${ref}`;

    const amountCents = ad.amount_cents || MARQUEE_CENTS_PER_HOUR;
    const price = amountCents / 100;
    const hours =
      ad.duration_hours ||
      Math.max(1, Math.round(amountCents / MARQUEE_CENTS_PER_HOUR));

    const payload = {
      product_sku: `marquee_ad_${adId}`,
      price,
      merchant_wallet: process.env.ESPEES_MERCHANT_WALLET || process.env.ESPEES_WALLET,
      narration: `Marquee advert: ${ad.title} (${hours} hour${hours === 1 ? '' : 's'})`,
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
      durationHours: hours,
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
      durationHours: hours,
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

/**
 * Records a marquee advert as paid and puts it in the approval queue.
 *
 * It used to go straight to 'active'. An advert is shown to every user of the
 * app, so it now waits for an admin — see adsController.approveAd, which is
 * what sets the run window, starting from the approval rather than from here,
 * so queue time does not eat into the days that were paid for.
 */
/**
 * Puts a paid advert live, starting its run window now.
 *
 * Review already happened — the advert reached payment only because an admin
 * approved it — so payment is the last step and the clock starts here. That
 * also means queue time never eats into the hours that were bought.
 *
 * Only ever called after Espees has confirmed the payment server-to-server.
 */
async function activatePaidAdvert(adId, confirmData = {}) {
  const paidAt = new Date().toISOString();
  const payment = {
    status: 'Paid',
    confirmedAt: paidAt,
    confirmation: confirmData,
  };
  const { rows } = await pool.query(
    `UPDATE advertisements SET
      status = 'active',
      paid_at = $1,
      start_at = $1,
      end_at = $1::timestamptz +
        (COALESCE(duration_hours, COALESCE(duration_days, 1) * 24) || ' hours')::interval,
      payment = $2
     WHERE id = $3
     RETURNING *`,
    [paidAt, JSON.stringify(payment), adId],
  );
  return rows[0] || null;
}

/** Parks an advert for an admin to resolve, rather than activating on doubt. */
async function flagAdvertForReview(adId, payment, label, detail) {
  await pool.query(
    `UPDATE advertisements SET payment = $1, status = 'pending_review' WHERE id = $2`,
    [JSON.stringify({ ...payment, status: label, detail }), adId],
  );
  const push = await pushToAdmins({
    title: 'Advert payment needs review',
    body: `An advert payment could not be confirmed (${label}).`,
    data: { type: 'ad_approval', adId: String(adId) },
  });
  if (!push.sent) {
    console.warn('[espees] review push not delivered:', push.reason || push);
  }
}

/** True when a confirmation payload looks like a completed payment. */
function looksPaid(confirmData) {
  const raw = String(
    confirmData?.status ?? confirmData?.payment_status ?? confirmData?.state ?? '',
  ).toLowerCase();
  // No status field at all is not treated as a failure — several Espees
  // responses carry only the amount — but a status that is present and says
  // something other than success is.
  if (!raw) return true;
  return raw.includes('paid') || raw.includes('success') || raw.includes('complete');
}

export const initPremiumPayment = async (req, res) => {
  try {
    const baseUrl = backendBaseUrl(req);
    // Signed for the same reason as the meetings subscription — see
    // paymentRefService.
    const ref = signedRefQuery('premium', req.userId, null);
    const success_url = `${baseUrl}/api/payments/premium/success?${ref}`;
    const fail_url = `${baseUrl}/api/payments/premium/failed?${ref}`;

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
    // The advert and the payer both come from the signed query. A bare
    // `?adId=` used to be enough here, which let anyone mark any advert paid.
    const ref = verifiedAdRef(req.query);
    if (!ref) {
      return res.status(400).send(paymentHtml(false, 'This payment link is not valid'));
    }
    const { userId, adId } = ref;

    const transaction_id =
      req.query.transaction_id || req.query.payment_id || req.query.product_id;

    const adRes = await pool.query(
      'SELECT * FROM advertisements WHERE id = $1 AND user_id = $2',
      [adId, userId],
    );
    if (!adRes.rows.length) {
      return res.status(404).send(paymentHtml(false, 'Advert not found'));
    }
    const ad = adRes.rows[0];

    let payment = {};
    try {
      payment = typeof ad.payment === 'string' ? JSON.parse(ad.payment) : ad.payment || {};
    } catch (_) {}

    if (payment.status === 'Paid' && ad.status === 'active') {
      return res.send(paymentHtml(true, 'Payment already confirmed'));
    }

    // Espees must confirm the payment server-to-server before anything goes
    // live. Without this, a signature alone would still let the advertiser
    // replay their own return URL and never pay — the signature proves who
    // the callback is about, not that money moved.
    const productId = transaction_id || ad.payment_id;
    if (!productId) {
      return res.send(
        paymentHtml(
          false,
          'We could not verify this payment. Nothing has been charged and your advert has not gone live.',
        ),
      );
    }

    let confirmData = {};
    try {
      const confirmResp = await axios.post(
        'https://api.espees.org/payment/confirm',
        { product_id: productId },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 },
      );
      confirmData = confirmResp.data || {};
    } catch (confirmErr) {
      // Unreachable or erroring provider is not proof of payment, so the
      // advert waits for an admin instead of being activated on faith.
      console.error('[espees] confirm failed:', confirmErr.message);
      await flagAdvertForReview(adId, payment, 'Unconfirmed', confirmErr.message);
      return res.send(
        paymentHtml(
          false,
          'We could not confirm your payment with Espees yet. An admin will check it and your advert will go live if the payment went through.',
        ),
      );
    }

    if (!looksPaid(confirmData)) {
      await flagAdvertForReview(adId, payment, 'NotPaid', confirmData?.status);
      return res.send(
        paymentHtml(false, 'Espees has not reported this payment as complete.'),
      );
    }

    const returnedAmount = confirmData?.price ?? confirmData?.amount;
    const expectedPrice = (ad.amount_cents || MARQUEE_CENTS_PER_HOUR) / 100;
    if (returnedAmount == null) {
      await flagAdvertForReview(adId, payment, 'AmountMissing', null);
      return res.send(
        paymentHtml(
          false,
          'Espees did not report the amount paid. An admin will check it.',
        ),
      );
    }
    if (parseFloat(returnedAmount) !== expectedPrice) {
      await flagAdvertForReview(adId, payment, 'Discrepancy', String(returnedAmount));
      return res.send(paymentHtml(false, 'Amount mismatch — contact support'));
    }

    const live = await activatePaidAdvert(adId, confirmData);
    const hours = live?.duration_hours || ad.duration_hours || 1;
    return res.send(
      paymentHtml(
        true,
        `Payment confirmed. Your advert is live for ${hours} hour${hours === 1 ? '' : 's'}.`,
      ),
    );
  } catch (err) {
    console.error('handleEspeesSuccess', err);
    return res.status(500).send(paymentHtml(false, 'Server error'));
  }
};

export const handleEspeesFailure = async (req, res) => {
  try {
    // Signed like the success callback, so one advertiser cannot mark another
    // advertiser's advert as failed.
    const ref = verifiedAdRef(req.query);
    if (ref) {
      await pool.query(
        `UPDATE advertisements SET status = 'payment_failed'
          WHERE id = $1 AND user_id = $2 AND status = 'approved_unpaid'`,
        [ref.adId, ref.userId],
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
      // Only an advert an admin has approved may be activated. A webhook for
      // anything else is parked for review rather than put in front of users.
      if (ad.status === 'approved_unpaid' || ad.status === 'pending_payment') {
        await activatePaidAdvert(ad.id, payload);
      } else {
        await flagAdvertForReview(ad.id, payment, 'UnexpectedStatus', ad.status);
      }
      return res.status(200).json({ received: true });
    }

    await pool.query(
      `UPDATE advertisements SET status = 'payment_failed', payment = $1
        WHERE id = $2 AND status <> 'active'`,
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

    const userId = verifiedUserId('premium', req.query, null);
    if (!userId) {
      return res.status(400).send(paymentHtml(false, 'This payment link is not valid'));
    }

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
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
              userId,
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
      [JSON.stringify(updatedData), userId],
    );

    return res.send(paymentHtml(true, 'Premium subscription activated'));
  } catch (err) {
    console.error('handlePremiumSuccess', err);
    return res.status(500).send(paymentHtml(false, 'Server error'));
  }
};

export const handlePremiumFailure = async (req, res) => {
  try {
    const userId = verifiedUserId('premium', req.query, null);
    if (userId) {
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length) {
        const user = userRes.rows[0];
        let premiumData = {};
        try {
          premiumData = typeof user.premium_data === 'string' ? JSON.parse(user.premium_data) : user.premium_data || {};
        } catch (_) {}

        await pool.query(
          `UPDATE users SET premium_data = $1 WHERE id = $2`,
          [JSON.stringify({ ...premiumData, status: 'payment_failed' }), userId],
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

// ─── Meetings Subscription ────────────────────────────────────────────────────

const MEETINGS_SUB_PLANS = {
  monthly: { price: 0.29, days: 30, label: '1 month' },
  yearly: { price: 2.99, days: 365, label: '1 year' },
};

export const initMeetingsSubscription = async (req, res) => {
  try {
    const planKey = MEETINGS_SUB_PLANS[req.body?.plan] ? req.body.plan : 'monthly';
    const plan = MEETINGS_SUB_PLANS[planKey];

    const baseUrl = backendBaseUrl(req);
    // The return URLs carry a signed user id. Espees reaches them by redirect,
    // which cannot send the `token` header that authRequired reads.
    const ref = signedRefQuery('meetings-sub', req.userId, planKey);
    const success_url = `${baseUrl}/api/payments/meetings-sub/success?${ref}`;
    const fail_url = `${baseUrl}/api/payments/meetings-sub/failed?${ref}`;

    const payload = {
      product_sku: `meetings_subscription_${planKey}_${req.userId}`,
      price: plan.price,
      merchant_wallet: process.env.ESPEES_MERCHANT_WALLET || process.env.ESPEES_WALLET,
      narration: `Calendar 360 Meetings Subscription (${plan.label})`,
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
      plan: planKey,
      amount: plan.price,
    });
  } catch (err) {
    console.error('initMeetingsSubscription', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      success: false,
      message: 'Payment init failed',
      details: err.response?.data || err.message,
    });
  }
};

export const handleMeetingsSubSuccess = async (req, res) => {
  try {
    const transaction_id = req.query.transaction_id || req.query.payment_id || req.query.product_id;
    const planKey = MEETINGS_SUB_PLANS[req.query.plan] ? req.query.plan : 'monthly';
    const plan = MEETINGS_SUB_PLANS[planKey];

    const userId = verifiedUserId('meetings-sub', req.query, planKey);
    if (!userId) {
      return res.status(400).send(paymentHtml(false, 'This payment link is not valid'));
    }

    const userRes = await pool.query(
      'SELECT meetings_sub FROM users WHERE id = $1',
      [userId],
    );
    if (!userRes.rows.length) {
      return res.status(404).send(paymentHtml(false, 'User not found'));
    }
    const user = userRes.rows[0];

    let sub = {};
    try {
      sub = typeof user.meetings_sub === 'string'
        ? JSON.parse(user.meetings_sub)
        : user.meetings_sub || {};
    } catch (_) {}

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
        if (returnedAmount != null && parseFloat(returnedAmount) !== plan.price) {
          await pool.query(`UPDATE users SET meetings_sub = $1 WHERE id = $2`, [
            JSON.stringify({ ...sub, status: 'Discrepancy', confirmation: confirmData }),
            userId,
          ]);
          return res.send(paymentHtml(false, 'Amount mismatch — contact support'));
        }
      } catch (confirmErr) {
        console.error('[espees] meetings-sub confirm', confirmErr.message);
      }
    }

    // Extend from current expiry when still active; otherwise start from now.
    const now = new Date();
    const currentExpiry = sub.expiresAt ? new Date(sub.expiresAt) : null;
    const baseDate = currentExpiry && currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(baseDate.getTime() + plan.days * 24 * 60 * 60 * 1000);

    const updatedSub = {
      status: 'active',
      plan: planKey,
      activatedAt: now.toISOString(),
      expiresAt: newExpiry.toISOString(),
      confirmation: confirmData,
    };

    await pool.query(`UPDATE users SET meetings_sub = $1 WHERE id = $2`, [
      JSON.stringify(updatedSub), userId,
    ]);

    return res.send(paymentHtml(true, `Meetings subscription activated for ${plan.label}`));
  } catch (err) {
    console.error('handleMeetingsSubSuccess', err);
    return res.status(500).send(paymentHtml(false, 'Server error'));
  }
};

export const handleMeetingsSubFailure = async (req, res) => {
  const details = req.query.status_details || 'Payment was not completed';
  return res.send(paymentHtml(false, details));
};

export const getMeetingsSubStatus = async (req, res) => {
  try {
    const userRes = await pool.query(
      'SELECT meetings_sub, meetings_free_used FROM users WHERE id = $1',
      [req.userId],
    );
    if (!userRes.rows.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const { active, expiresAt, isFree, freeUsesLeft, freeUsesTotal } =
      computeMeetingsAccess(userRes.rows[0]);
    return res.json({
      success: true,
      active,
      expiresAt,
      isFree,
      freeUsesLeft,
      freeUsesTotal,
    });
  } catch (err) {
    console.error('getMeetingsSubStatus', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

