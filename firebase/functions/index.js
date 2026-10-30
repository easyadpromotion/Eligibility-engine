/**
 * DSA Command Center: 2Factor.in OTP login
 *
 * The browser never sees the 2Factor API key. Flow:
 *   1. POST /sendOtp   {phone}            -> 2Factor AUTOGEN SMS, returns an opaque sessionId
 *   2. POST /verifyOtp {sessionId, otp}   -> 2Factor VERIFY, returns a Firebase custom token
 *   3. Browser calls signInWithCustomToken(token); firestore.rules take over from there.
 *
 * Abuse protection: OTPs go only to numbers already in the `staff` collection, at most
 * one SMS per 30 s and 5 per hour per number, 5 wrong attempts per session, 10-minute expiry.
 */
const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret, defineString} = require('firebase-functions/params');
const {initializeApp} = require('firebase-admin/app');
const {getAuth} = require('firebase-admin/auth');
const {getFirestore, FieldValue, Timestamp} = require('firebase-admin/firestore');
const crypto = require('crypto');

initializeApp();
const db = getFirestore();

const TWOFACTOR_API_KEY = defineSecret('TWOFACTOR_API_KEY');
// Name of the SMS template approved in your 2Factor account (DLT). Set in functions/.env
const TWOFACTOR_TEMPLATE = defineString('TWOFACTOR_TEMPLATE', {default: ''});
// Comma-separated list of sites allowed to call these functions
const ALLOWED_ORIGINS = defineString('ALLOWED_ORIGINS', {default: 'https://easyadpromotion.github.io,https://credir-engine-new.web.app,https://credir-engine-new.firebaseapp.com'});
// First-time setup: this number becomes Admin on its first OTP login, but only while no Admin exists yet.
const BOOTSTRAP_ADMIN = defineString('BOOTSTRAP_ADMIN', {default: ''});
const BOOTSTRAP_ADMIN_NAME = defineString('BOOTSTRAP_ADMIN_NAME', {default: 'Admin'});
const BOOTSTRAP_BRANCH = defineString('BOOTSTRAP_BRANCH', {default: 'Main Branch'});

async function bootstrapAllowed(e164) {
  const want = String(BOOTSTRAP_ADMIN.value() || '').replace(/\D/g, '').slice(-10);
  if (!want || '+91' + want !== e164) return false;
  const admins = await db.collection('staff').where('role', '==', 'Admin').limit(1).get();
  return admins.empty;
}

const OPTS = {region: 'asia-south1', secrets: [TWOFACTOR_API_KEY], maxInstances: 5, timeoutSeconds: 20};
const SESSION_TTL_MS = 10 * 60 * 1000;
const RESEND_GAP_MS = 30 * 1000;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

function cors(req, res) {
  const allowed = ALLOWED_ORIGINS.value().split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.get('origin') || '';
  if (origin && allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
  }
  if (req.method === 'OPTIONS') { res.status(origin && allowed.includes(origin) ? 204 : 403).send(''); return false; }
  if (req.method !== 'POST') { res.status(405).json({code: 'method', message: 'Use POST'}); return false; }
  if (origin && !allowed.includes(origin)) { res.status(403).json({code: 'origin', message: 'This site is not allowed to sign in.'}); return false; }
  return true;
}

const normalisePhone = raw => {
  const d = String(raw || '').replace(/\D/g, '');
  const ten = d.length >= 10 ? d.slice(-10) : '';
  if (!/^[6-9]\d{9}$/.test(ten)) throw new HttpError(400, 'phone', 'Enter a valid 10-digit mobile number.');
  return {ten, e164: '+91' + ten};
};

// A 2Factor key is a UUID. Pull it out of whatever was pasted into the secret prompt
// (terminals can wrap pastes in invisible escape codes, or a label like "API Key" gets copied too).
function apiKey() {
  const raw = String(TWOFACTOR_API_KEY.value() || '');
  const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : raw.trim();
}

async function twoFactor(path) {
  const r = await fetch(`https://2factor.in/API/V1/${encodeURIComponent(apiKey())}/${path}`, {method: 'GET', signal: AbortSignal.timeout(10000)});
  const text = await r.text();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { body = {Status: 'Error', Details: `HTTP ${r.status}: ${text.slice(0, 200)}`}; }
  return {ok: r.ok, body};
}

const handle = fn => onRequest(OPTS, async (req, res) => {
  if (!cors(req, res)) return;
  try { res.json(await fn(req.body || {})); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({code: e.code, message: e.message});
    console.error(e);
    res.status(500).json({code: 'server', message: 'Something went wrong. Please try again.'});
  }
});

exports.sendOtp = handle(async body => {
  const {ten, e164} = normalisePhone(body.phone);

  // Only registered team members get an SMS (stops strangers spending your SMS credit)
  const staff = await db.doc(`staff/${e164}`).get();
  const boot = !staff.exists && await bootstrapAllowed(e164);
  if (!staff.exists && !boot) throw new HttpError(403, 'not_registered', 'This number is not registered. Ask your admin to add you in Staff & Settings.');
  const status = boot ? 'Approved' : staff.get('status');
  if (status !== 'Approved') throw new HttpError(403, 'not_approved', `Your access is ${status || 'pending'}. Please contact your admin.`);

  // Rate limit per number
  const limRef = db.doc(`otp_limits/${e164}`);
  const now = Date.now();
  await db.runTransaction(async tx => {
    const snap = await tx.get(limRef);
    const sent = (snap.exists ? snap.get('sent') || [] : []).filter(t => now - t < 3600e3);
    if (sent.length && now - sent[sent.length - 1] < RESEND_GAP_MS) throw new HttpError(429, 'wait', 'Please wait 30 seconds before asking for another OTP.');
    if (sent.length >= MAX_PER_HOUR) throw new HttpError(429, 'limit', 'Too many OTP requests. Try again in an hour.');
    tx.set(limRef, {sent: [...sent, now]});
  });

  const tpl = String(TWOFACTOR_TEMPLATE.value() || '').trim();
  // No template name → 2Factor's default OTP SMS template
  const {ok, body: r} = await twoFactor(`SMS/+91${ten}/AUTOGEN${tpl ? '/' + encodeURIComponent(tpl) : ''}`);
  if (!ok || r.Status !== 'Success' || !r.Details) {
    console.error('2Factor send failed', r);
    throw new HttpError(502, 'sms_failed', 'Could not send the OTP SMS right now. Please try again in a minute.');
  }

  // Keep 2Factor's session id on the server; the browser gets our own random id
  const sessionId = crypto.randomBytes(24).toString('hex');
  await db.doc(`otp_sessions/${sessionId}`).set({phone: e164, tfSession: r.Details, attempts: 0, createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(now + SESSION_TTL_MS)});
  return {sessionId, resendIn: RESEND_GAP_MS / 1000};
});

exports.verifyOtp = handle(async body => {
  const sessionId = String(body.sessionId || '');
  const otp = String(body.otp || '').trim();
  if (!/^[a-f0-9]{48}$/.test(sessionId)) throw new HttpError(400, 'session', 'OTP session missing. Request a new OTP.');
  if (!/^\d{4,8}$/.test(otp)) throw new HttpError(400, 'otp', 'Enter the OTP you received.');

  const ref = db.doc(`otp_sessions/${sessionId}`);
  const s = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(400, 'session', 'OTP session expired. Request a new OTP.');
    const d = snap.data();
    if (d.expiresAt.toMillis() < Date.now()) { tx.delete(ref); throw new HttpError(400, 'expired', 'OTP expired. Request a new one.'); }
    if (d.attempts >= MAX_ATTEMPTS) { tx.delete(ref); throw new HttpError(429, 'attempts', 'Too many wrong attempts. Request a new OTP.'); }
    tx.update(ref, {attempts: FieldValue.increment(1)});
    return d;
  });

  const {body: r} = await twoFactor(`SMS/VERIFY/${encodeURIComponent(s.tfSession)}/${encodeURIComponent(otp)}`);
  const matched = r.Status === 'Success' && /match/i.test(String(r.Details || ''));
  if (!matched) throw new HttpError(401, 'wrong_otp', 'Wrong OTP. Please check and try again.');
  await ref.delete();

  // First Admin: create the staff profile on the very first login (only while no Admin exists)
  if (!(await db.doc(`staff/${s.phone}`).get()).exists && await bootstrapAllowed(s.phone)) {
    await db.doc(`staff/${s.phone}`).set({name: BOOTSTRAP_ADMIN_NAME.value(), phone: s.phone, role: 'Admin', branch: BOOTSTRAP_BRANCH.value(), status: 'Approved', createdAt: new Date().toISOString(), createdBy: 'bootstrap'});
  }
  // Re-check access at sign-in time (the admin may have put the person on hold meanwhile)
  const staff = await db.doc(`staff/${s.phone}`).get();
  if (!staff.exists || staff.get('status') !== 'Approved') throw new HttpError(403, 'not_approved', 'Your access is not active. Please contact your admin.');

  // One Firebase user per phone number (reuses any existing phone-auth user)
  const auth = getAuth();
  let uid;
  try { uid = (await auth.getUserByPhoneNumber(s.phone)).uid; }
  catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    uid = (await auth.createUser({uid: s.phone, phoneNumber: s.phone, displayName: staff.get('name') || undefined})).uid;
  }
  const token = await auth.createCustomToken(uid, {phone_number: s.phone});
  return {token};
});
