const crypto = require('crypto');

const pool = require('../config/db');

// =====================================================
// SHOPPER TRAINING QUIZ (phase 46, 2026-10-29)
//
// Optional (shopper_training_settings.training_required, default off).
// When on, it applies only to shoppers whose account became active
// (GREATEST(approved_at, activated_at)) at or after training_enabled_at
// - existing shoppers are never blocked. Such a shopper can't go online
// (403 TRAINING_REQUIRED) until one attempt answers every question
// correctly. The server grades: the app never receives the correct
// answers, only which questions were wrong.
//   Shopper: GET /api/shopper/training, POST /api/shopper/training/submit
//   Admin:   GET / PUT /api/admin/shopper-training/settings
// =====================================================

// Default set written for GetMe (questions NULL in the settings row)
const DEFAULT_QUESTIONS = [
  {
    id: 'delivery_pin',
    text: 'You arrive with an order. Where does the delivery PIN come from?',
    options: [
      'It is shown in the Shopper App, so I can type it in myself',
      'The customer gives it to me when I hand over the order',
      'The store cashier prints it on the bill',
      'I can skip the PIN if the customer is busy',
    ],
    correctIndex: 1,
  },
  {
    id: 'store_bill',
    text: 'What do you do with every store bill?',
    options: [
      'Throw it away after paying',
      'Give it to the customer, no photo needed',
      'Photograph it in the app before leaving the store',
      'Keep it and send it to GetMe at the end of the month',
    ],
    correctIndex: 2,
  },
  {
    id: 'replacements',
    text: 'An item is out of stock and you found a similar one. What do you do?',
    options: [
      'Buy it - customers always accept a replacement',
      'Buy a more expensive brand without asking',
      'Cancel the whole order',
      'Ask the customer in the app and buy it only if they approve',
    ],
    correctIndex: 3,
  },
  {
    id: 'cash',
    text: 'A customer pays the order in cash. What happens to that cash?',
    options: [
      'I hand the collected cash over to GetMe as shown in the app',
      'I keep it as my tip',
      'I give it to the store',
      'I keep it until the customer asks for it back',
    ],
    correctIndex: 0,
  },
  {
    id: 'help_button',
    text: 'You are in danger, had an accident or need urgent help during a job. What do you do?',
    options: [
      'Turn off the app and go home',
      'Press "I need help" in the app, and call 119 (police) or 1990 (ambulance) in an emergency',
      'Message the customer and wait',
      'Finish the delivery first, then tell GetMe',
    ],
    correctIndex: 1,
  },
];

// Short rules shown above the questions
const RULES = [
  'Only the customer gives you the delivery PIN - ask for it when you hand over the order.',
  'Photograph every store bill in the app before you leave the store.',
  'Replacements need the customer\'s approval in the app. Never swap items without asking.',
  'Cash you collect from customers belongs to GetMe: hand it over as the app shows.',
  'In danger or after an accident, press "I need help". In an emergency call 119 (police) or 1990 (ambulance).',
];

const LIMITS = { questions: 15, options: 5, text: 300, option: 150, attemptsPerHour: 10 };

const error = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

// -----------------------------------------------------
// Settings
// -----------------------------------------------------

const loadSettings = async (client = pool) => {
  const row = (
    await client.query(
      `SELECT st.*, ad.full_name AS updated_by_name FROM shopper_training_settings st
       LEFT JOIN admins ad ON ad.id = st.updated_by WHERE st.id = 1`
    )
  ).rows[0] || {};
  const custom = Array.isArray(row.questions) && row.questions.length > 0;
  return {
    trainingRequired: Boolean(row.training_required),
    trainingEnabledAt: row.training_enabled_at || null,
    questions: custom ? row.questions : DEFAULT_QUESTIONS,
    usingDefaults: !custom,
    questionsVersion: Number(row.questions_version) || 1,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by_name || null,
  };
};

// Questions without the answers (shopper app)
const publicQuestions = (questions) => questions.map(({ id, text, options }) => ({ id, text, options }));

// -----------------------------------------------------
// One shopper's status
// -----------------------------------------------------

const statusFor = async (shopperId, { client = pool, withAttempts = false, settings = null } = {}) => {
  const s = settings || (await loadSettings(client));
  const row = (
    await client.query(
      `SELECT GREATEST(sh.approved_at, sh.activated_at) AS activated_at,
              (SELECT MIN(a.created_at) FROM shopper_training_attempts a WHERE a.shopper_id = sh.id AND a.passed) AS passed_at,
              (SELECT COUNT(*)::int FROM shopper_training_attempts a WHERE a.shopper_id = sh.id) AS attempts
       FROM shoppers sh WHERE sh.id = $1`,
      [Number(shopperId)]
    )
  ).rows[0];
  if (!row) return null;
  const applies = Boolean(
    s.trainingRequired && s.trainingEnabledAt && row.activated_at &&
    new Date(row.activated_at).getTime() >= new Date(s.trainingEnabledAt).getTime()
  );
  const passed = Boolean(row.passed_at);
  const status = {
    required: s.trainingRequired,
    applies,
    passed,
    passedAt: row.passed_at || null,
    blocking: applies && !passed,
    activatedAt: row.activated_at || null,
    attemptCount: row.attempts,
  };
  if (withAttempts) {
    const attempts = await client.query(
      `SELECT id, questions_version, wrong_question_ids, score, total, passed, created_at
       FROM shopper_training_attempts WHERE shopper_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [Number(shopperId)]
    );
    status.attempts = attempts.rows.map((a) => ({
      id: Number(a.id),
      questionsVersion: a.questions_version,
      score: a.score,
      total: a.total,
      passed: a.passed,
      wrongQuestionIds: a.wrong_question_ids,
      at: a.created_at,
    }));
  }
  return status;
};

// The go-online refusal (null when fine)
const gateBlock = async (shopperId) => {
  const status = await statusFor(shopperId);
  if (!status?.blocking) return null;
  return {
    code: 'TRAINING_REQUIRED',
    message: 'Before you go online for the first time, complete the short GetMe training quiz (5 questions). Tap "Start training".',
  };
};

// -----------------------------------------------------
// Shopper API
// -----------------------------------------------------

const shopperIdOf = (req) => Number(req.shopper?.shopperId);

const sendError = (res, err, fallback) => {
  if (!err?.status) console.error(`❌ ${fallback}:`, err?.message || err);
  return res.status(err?.status || 500).json({
    success: false,
    code: err?.code,
    message: err?.status ? err.message : fallback,
    ...(err?.training ? { training: err.training } : {}),
  });
};

const trainingView = async (shopperId) => {
  const settings = await loadSettings();
  const status = await statusFor(shopperId, { settings });
  if (!status) throw error(404, 'Shopper not found', 'NOT_FOUND');
  const last = (
    await pool.query(
      `SELECT wrong_question_ids, score, total, passed, questions_version, created_at
       FROM shopper_training_attempts WHERE shopper_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [shopperId]
    )
  ).rows[0];
  return {
    required: status.required,
    applies: status.applies,
    passed: status.passed,
    passedAt: status.passedAt,
    canGoOnline: !status.blocking,
    passMark: 'all',
    rules: RULES,
    questionsVersion: settings.questionsVersion,
    questions: publicQuestions(settings.questions),
    lastAttempt: last
      ? {
          at: last.created_at,
          passed: last.passed,
          score: last.score,
          total: last.total,
          // Only meaningful while the questions are the same
          wrongQuestionIds: last.questions_version === settings.questionsVersion ? last.wrong_question_ids : [],
        }
      : null,
  };
};

// GET /api/shopper/training
const getTraining = async (req, res) => {
  try {
    return res.json({ success: true, training: await trainingView(shopperIdOf(req)) });
  } catch (err) {
    return sendError(res, err, 'Unable to load the training');
  }
};

// POST /api/shopper/training/submit { answers: { [questionId]: optionIndex }, questionsVersion? }
const submitTraining = async (req, res) => {
  const shopperId = shopperIdOf(req);
  try {
    const answers = req.body?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw error(400, 'Answer the questions first', 'INVALID_ANSWERS');
    }
    const settings = await loadSettings();
    const version = req.body?.questionsVersion;
    if (version != null && Number(version) !== settings.questionsVersion) {
      throw error(409, 'The questions were updated. Please answer the new ones.', 'QUESTIONS_CHANGED', {
        training: await trainingView(shopperId),
      });
    }
    const recent = (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM shopper_training_attempts WHERE shopper_id = $1 AND created_at > NOW() - INTERVAL '1 hour'",
        [shopperId]
      )
    ).rows[0].n;
    if (recent >= LIMITS.attemptsPerHour) {
      throw error(429, 'Too many attempts. Read the rules again and try later.', 'TOO_MANY_ATTEMPTS');
    }

    const clean = {};
    const wrong = [];
    settings.questions.forEach((q) => {
      const raw = answers[q.id];
      const index = Number.isInteger(Number(raw)) && raw !== null && raw !== '' ? Number(raw) : null;
      if (index != null && index >= 0 && index < q.options.length) clean[q.id] = index;
      if (clean[q.id] !== q.correctIndex) wrong.push(q.id);
    });
    const total = settings.questions.length;
    const score = total - wrong.length;
    const passed = wrong.length === 0;

    await pool.query(
      `INSERT INTO shopper_training_attempts (shopper_id, questions_version, answers, wrong_question_ids, score, total, passed)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [shopperId, settings.questionsVersion, JSON.stringify(clean), wrong, score, total, passed]
    );

    return res.json({
      success: true,
      passed,
      score,
      total,
      // Which ones were wrong - never the correct answers
      wrongQuestionIds: wrong,
      message: passed
        ? 'Well done - you passed the GetMe training. You can go online now.'
        : `${score} of ${total} correct. Read the rules again and retry the ${wrong.length === 1 ? 'question' : 'questions'} marked wrong.`,
      training: await trainingView(shopperId),
    });
  } catch (err) {
    return sendError(res, err, 'Unable to check your answers');
  }
};

// -----------------------------------------------------
// Admin API
// -----------------------------------------------------

// Questions from the settings card -> clean list (throws 400)
const cleanQuestions = (input) => {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMITS.questions) {
    throw error(400, `Add 1 to ${LIMITS.questions} questions`, 'INVALID_QUESTIONS');
  }
  const ids = new Set();
  return input.map((q, n) => {
    const label = `Question ${n + 1}`;
    const text = String(q?.text || '').trim();
    if (text.length < 5 || text.length > LIMITS.text) throw error(400, `${label}: write 5 to ${LIMITS.text} characters`, 'INVALID_QUESTIONS');
    const options = Array.isArray(q?.options) ? q.options.map((o) => String(o ?? '').trim()) : [];
    if (options.length < 2 || options.length > LIMITS.options) throw error(400, `${label}: give 2 to ${LIMITS.options} answers`, 'INVALID_QUESTIONS');
    if (options.some((o) => !o || o.length > LIMITS.option)) throw error(400, `${label}: every answer needs 1 to ${LIMITS.option} characters`, 'INVALID_QUESTIONS');
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw error(400, `${label}: answers must be different`, 'INVALID_QUESTIONS');
    const correctIndex = Number(q?.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      throw error(400, `${label}: choose the correct answer`, 'INVALID_QUESTIONS');
    }
    let id = /^[a-z0-9_-]{1,40}$/.test(String(q?.id || '')) ? String(q.id) : `q_${crypto.randomBytes(4).toString('hex')}`;
    while (ids.has(id)) id = `q_${crypto.randomBytes(4).toString('hex')}`;
    ids.add(id);
    return { id, text, options, correctIndex };
  });
};

const settingsView = async () => {
  const s = await loadSettings();
  const stats = (
    await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM shopper_training_attempts) AS attempts,
         (SELECT COUNT(DISTINCT shopper_id)::int FROM shopper_training_attempts WHERE passed) AS passed_shoppers,
         (SELECT COUNT(*)::int FROM shoppers sh
           WHERE $1::boolean AND $2::timestamptz IS NOT NULL
             AND sh.approval_status = 'approved'
             AND GREATEST(sh.approved_at, sh.activated_at) >= $2::timestamptz
             AND NOT EXISTS (SELECT 1 FROM shopper_training_attempts a WHERE a.shopper_id = sh.id AND a.passed)) AS waiting`,
      [s.trainingRequired, s.trainingEnabledAt]
    )
  ).rows[0];
  return {
    settings: {
      trainingRequired: s.trainingRequired,
      trainingEnabledAt: s.trainingEnabledAt,
      questions: s.questions,
      questionsVersion: s.questionsVersion,
      usingDefaults: s.usingDefaults,
      passMark: 'all',
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy,
    },
    rules: RULES,
    defaults: DEFAULT_QUESTIONS,
    stats: { attempts: stats.attempts, passedShoppers: stats.passed_shoppers, waitingShoppers: stats.waiting },
    note: 'Applies only to shoppers whose account is approved / activated after the requirement is switched on. Pass mark: every answer correct.',
  };
};

// GET /api/admin/shopper-training/settings
const getSettings = async (req, res) => {
  try {
    return res.json({ success: true, ...(await settingsView()) });
  } catch (err) {
    return sendError(res, err, 'Unable to load the training settings');
  }
};

// PUT /api/admin/shopper-training/settings { trainingRequired?, questions?, resetQuestions? }
const updateSettings = async (req, res) => {
  const body = req.body || {};
  try {
    if (body.trainingRequired !== undefined && typeof body.trainingRequired !== 'boolean') {
      throw error(400, 'trainingRequired must be true or false', 'INVALID_SETTING');
    }
    const before = await loadSettings();
    const questions = body.resetQuestions === true ? null : body.questions !== undefined ? cleanQuestions(body.questions) : undefined;
    const required = body.trainingRequired ?? before.trainingRequired;
    const nextQuestions = questions === undefined ? (before.usingDefaults ? null : before.questions) : questions;
    const questionsChanged = JSON.stringify(nextQuestions || DEFAULT_QUESTIONS) !== JSON.stringify(before.questions) ||
      (nextQuestions == null) !== before.usingDefaults;

    await pool.query(
      `UPDATE shopper_training_settings
       SET training_required = $1,
           training_enabled_at = CASE WHEN $1 AND NOT training_required THEN NOW() ELSE training_enabled_at END,
           questions = $2::jsonb,
           questions_version = questions_version + CASE WHEN $3 THEN 1 ELSE 0 END,
           updated_by = $4, updated_at = NOW()
       WHERE id = 1`,
      [required, nextQuestions ? JSON.stringify(nextQuestions) : null, questionsChanged, req.admin?.adminId ?? null]
    );
    const after = await loadSettings();
    const brief = (s) => ({
      trainingRequired: s.trainingRequired,
      trainingEnabledAt: s.trainingEnabledAt,
      questionsVersion: s.questionsVersion,
      questionCount: s.questions.length,
      usingDefaults: s.usingDefaults,
    });
    res.locals.audit = {
      summary: `Shopper training: ${after.trainingRequired ? 'required before first online' : 'not required'}; ${after.questions.length} question(s)${questionsChanged ? `, questions changed (v${after.questionsVersion})` : ''}`,
      before: brief(before),
      after: brief(after),
    };
    return res.json({ success: true, message: 'Training settings saved', ...(await settingsView()) });
  } catch (err) {
    return sendError(res, err, 'Unable to save the training settings');
  }
};

module.exports = {
  DEFAULT_QUESTIONS,
  RULES,
  loadSettings,
  statusFor,
  gateBlock,
  getTraining,
  submitTraining,
  getSettings,
  updateSettings,
};
