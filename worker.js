/**
 * Cloudflare Worker: Telegram Business Auto-Responder Bot with Gemini API,
 * Multi-Model Fallback, Vision/Audio Multimodal Support & Chat History Continuity.
 *
 * Principal: Habtamu Yifiru (@smart_x_help / Smart x Ethiopian)
 * Target Platform: Cloudflare Workers (ES Modules format)
 *
 * Environment Variables / Secrets Required in Cloudflare Worker Dashboard:
 *  - TELEGRAM_BOT_TOKEN : Bot token from @BotFather
 *  - GEMINI_API_KEY     : Google AI Studio Gemini API Key
 *  - ADMIN_CHAT_ID      : Admin's private Telegram User/Chat ID for error alerts
 */

// Fallback sequence of Gemini models in order of preference
const GEMINI_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash'
];

// In-memory sliding window cache for recent conversation history per chat_id
const CHAT_HISTORIES = new Map();
const MAX_HISTORY_TURNS = 10; // Keep up to last 10 turns (5 user + 5 model)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Webhook Setup Endpoint (/register or /setWebhook)
    if (url.pathname === '/register' || url.pathname === '/setWebhook') {
      return await handleSetWebhook(url.origin, env);
    }

    // 2. Incoming Telegram Update Receiver (HTTPS POST)
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        await handleTelegramUpdate(update, env);
      } catch (err) {
        console.error('Unhandled Telegram Processing Error:', err);
        // Dispatch alert to Admin private chat on failure
        await sendAdminErrorAlert(err, env);
      }

      // CRITICAL: Always return HTTP 200 OK to Telegram to prevent infinite webhook retries
      return new Response('OK', { status: 200 });
    }

    // 3. Status & Health Landing Page
    return new Response(
      `🤖 Telegram Business Auto-Responder Worker (Gemini Multi-Model Multimodal)\n\n` +
      `Status: Live & Operational\n` +
      `Assistant Partner for: Habtamu Yifiru (@smart_x_help / Smart x Ethiopian)\n` +
      `Platform: Cloudflare Workers\n\n` +
      `• Active Models: ${GEMINI_MODELS.join(', ')}\n` +
      `• Capabilities: Chat History Memory, Voice/Audio, Image Vision, Multi-Model Fallback\n` +
      `• Webhook Receiver Endpoint: POST ${url.origin}/\n` +
      `• Register Webhook Endpoint: GET ${url.origin}/register`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }
    );
  }
};

/**
 * Main Handler for Telegram Updates (business_message or standard message)
 */
async function handleTelegramUpdate(update, env) {
  const message = update.business_message || update.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const businessConnectionId = message.business_connection_id || update.business_connection_id;
  if (!chatId) return;

  const userParts = [];
  let userCaption = message.text || message.caption || '';

  // Step 1: Send typing status indicator to Telegram
  await sendTelegramChatAction(env.TELEGRAM_BOT_TOKEN, chatId, 'typing', businessConnectionId);

  // Step 2: Handle incoming Images/Photos (Vision)
  if (message.photo && message.photo.length > 0) {
    const largestPhoto = message.photo[message.photo.length - 1];
    const imageBase64 = await getTelegramFileBase64(env.TELEGRAM_BOT_TOKEN, largestPhoto.file_id);
    if (imageBase64) {
      userParts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64
        }
      });
    }
  }

  // Step 3: Handle incoming Voice / Audio notes
  if (message.voice || message.audio) {
    const audioObj = message.voice || message.audio;
    const mimeType = message.voice ? 'audio/ogg' : (audioObj.mime_type || 'audio/mpeg');
    const audioBase64 = await getTelegramFileBase64(env.TELEGRAM_BOT_TOKEN, audioObj.file_id);
    if (audioBase64) {
      userParts.push({
        inlineData: {
          mimeType: mimeType,
          data: audioBase64
        }
      });
    }
  }

  // Step 4: Handle Stickers
  if (message.sticker) {
    const emoji = message.sticker.emoji || '😊';
    if (!userCaption) userCaption = `[User sent a sticker ${emoji}]`;
  }

  // Push user text/caption if present or fallback
  if (userCaption) {
    userParts.push({ text: userCaption });
  } else if (userParts.length === 0) {
    // Empty media fallback
    userParts.push({ text: 'Hello!' });
  }

  // Step 5: Construct Chat History Context
  let history = CHAT_HISTORIES.get(chatId) || [];

  // Check if user is replying to a previous message
  if (message.reply_to_message) {
    const replyText = message.reply_to_message.text || message.reply_to_message.caption;
    if (replyText) {
      // Add context turn if history is empty
      if (history.length === 0) {
        history.push({ role: 'user', parts: [{ text: `[Context: Replying to previous message: "${replyText}"]` }] });
      }
    }
  }

  const contents = [
    ...history,
    {
      role: 'user',
      parts: userParts
    }
  ];

  // Step 6: Call Gemini API with Multi-Model Fallback & Chat History
  const aiResponse = await callGeminiWithFallback(contents, env.GEMINI_API_KEY, userCaption);

  // Step 7: Update Local Sliding Window Chat History
  history.push({ role: 'user', parts: userParts });
  history.push({ role: 'model', parts: [{ text: aiResponse }] });
  CHAT_HISTORIES.set(chatId, history.slice(-MAX_HISTORY_TURNS));

  // Step 8: Send AI reply back to user via Telegram
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, aiResponse, businessConnectionId);
}

/**
 * Download a file from Telegram API and convert to base64 for Gemini Multimodal API
 */
async function getTelegramFileBase64(token, fileId) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    if (!fileRes.ok) return null;

    const fileData = await fileRes.json();
    const filePath = fileData.result?.file_path;
    if (!filePath) return null;

    const downloadRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!downloadRes.ok) return null;

    const arrayBuffer = await downloadRes.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (e) {
    console.error('Error fetching file from Telegram:', e);
    return null;
  }
}

/**
 * Call Gemini API using a Multi-Model Fallback system with Automatic Retry logic
 */
async function callGeminiWithFallback(contents, apiKey, userPromptText = '') {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is missing.');
  }

  const systemInstructionText =
    `You are the elite, warm, and highly professional personal assistant for Habtamu Yifiru (@smart_x_help / Smart x Ethiopian creator).\n\n` +
    `🛑 CRITICAL STRICT RULES:\n` +
    `1. NO REPETITIVE INTRODUCTIONS: NEVER say "I am an AI", "እኔ AI ነኝ", or mention any company/agency. Do NOT introduce yourself or state your role unless the user explicitly asks "Who are you?".\n` +
    `2. ABSOLUTE CONCISE RESPONSES: Keep every response short, clean, direct, and decorated with tasteful emojis 😊. Maximum 2-4 lines or clean bullet steps. No giant essays or mechanical walls of text.\n` +
    `3. CHAT HISTORY CONTINUITY: Always read and respect the previous chat history naturally. If the user replies with short words like "እሺ", "አረ", "አዎ", respond naturally in context without resetting.\n\n` +
    `📚 INBOX SCENARIO & REGISTRATION STEPS (Short Notes, Worksheets & App Release):\n` +
    `- CONTEXT: Habtamu posts on groups: "short note and worksheet የምትፈልጉ በ inbox አውሩን".\n` +
    `- When users message in inbox (e.g., "እኔ እፈልጋለው", "hi", "worksheet", "short note", "መዝግቡኝ", "እንዴት ላግኝ", "ጥያቄ አለኝ", or any related request):\n` +
    `  1. Greet them warmly and provide the registration bot: **@SmartX_PreRegister_bot**.\n` +
    `  2. Give them the clear step-by-step guidance:\n` +
    `     • **ደረጃ 1**: @SmartX_PreRegister_bot ገብተው **/start** ይበሉ\n` +
    `     • **ደረጃ 2**: **Language (ቋንቋ)** ይምረጡ (አማርኛ ወይም English)\n` +
    `     • **ደረጃ 3**: የክፍል ደረጃዎን ይምረጡ (**Grade 9 - 12**)\n` +
    `     • **ደረጃ 4**: የፍላጎት ማረጋገጫ **5 አጫጭር ጥያቄዎችን** ይመልሱ\n` +
    `     • **ደረጃ 5**: ጥያቄዎቹን ሲጨርሱ **Telegram Channel Join** ያድርጉ እና **ስልክ ቁጥርዎን Share ያድርጉ**\n` +
    `  3. Inform them: **Smart x Ethiopian Mobile Application** በይፋ **መስከረም 5** ይለቀቃል! እርምጃዎቹን አጠናቀው Notification on አድርገው ይጠብቁ።\n` +
    `  4. SCREENSHOT RULE: Do NOT ask for screenshots by default. Only tell them: "የከበዳችሁ ወይም ያልገባችሁ ደረጃ ካለ የ Screen Shot ምስል ላኩልን፣ በደስታ እናግዛችኋለን! 😊"\n\n` +
    `🎙️ VISION, TROUBLESHOOTING & MULTIMODAL:\n` +
    `1. TROUBLESHOOTING SCREENSHOTS: When a user sends a screenshot of any step in @SmartX_PreRegister_bot where they got stuck or confused, analyze the exact screen/button/prompt, tell them what went wrong or what to click next in simple Amharic/English, and guide them to finish.\n` +
    `2. GENERAL IMAGES: If an image is a question, worksheet, code snippet, or document, provide a clean, accurate, and direct explanation.\n` +
    `3. VOICE / AUDIO NOTES: Seamlessly answer voice notes or transcripts directly without commenting that it was audio.\n\n` +
    `⚠️ SCREENSHOT / FORWARD WARNING RULE:\n` +
    `- If a user asks about forwarding, leaking, or screenshotting chat content outside, politely remind them:\n` +
    `  "⚠️ *ለደህንነት ሲባል የዚህ chat መረጃዎች Forward ማድረግ ወይም Screenshot ማንሳት የተከለከሉ ናቸው። ለተጨማሪ መረጃ በ 0992480372 ያግኙን!*"\n\n` +
    `🧠 TONE & PERSONALITY (HUMAN-LIKE):\n` +
    `- Speak warmly, politely, and casually like a real professional human assistant.\n` +
    `- Match the user's language seamlessly (Amharic / አማርኛ, Afaan Oromoo, or English).\n` +
    `- Always end with a polite, natural follow-up question or helpful closing.\n\n` +
    `📞 OFFICIAL CONTACT DETAILS:\n` +
    `Only share when requested or relevant:\n` +
    `- Telegram Username: @smart_x_help\n` +
    `- Pre-Registration Bot: @SmartX_PreRegister_bot\n` +
    `- Phone Number: 0992480372\n` +
    `- YouTube Channel: https://www.youtube.com/@smartx.ethiopia\n` +
    `- App Release Date: መስከረም 5 (Smart x Ethiopian Mobile App)\n\n` +
    `🛑 OUTPUT FORMATTING CLEANLINESS:\n` +
    `- Output ONLY the final raw chat text meant for the user.\n` +
    `- NEVER output debug logs, character counts, internal reasoning, or quotation marks.`;

  const payload = {
    contents: contents,
    systemInstruction: {
      parts: [{ text: systemInstructionText }]
    },
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1000
    }
  };

  const modelErrors = [];

  // Iterate through the fallback list of Gemini models
  for (const modelName of GEMINI_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    // Retry loop for transient errors (e.g., 503 Service Unavailable or 429 Rate Limit)
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[Gemini Retry] Retrying ${modelName} (Attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if ((response.status === 503 || response.status === 429) && attempt < MAX_RETRIES) {
          console.warn(`[Gemini ${modelName}] HTTP ${response.status}. Retrying...`);
          continue;
        }

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`HTTP ${response.status}: ${errBody}`);
        }

        const data = await response.json();
        const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!replyText) {
          throw new Error('Returned empty or invalid candidate content.');
        }

        console.log(`[Gemini Success] Successfully generated response using model: ${modelName}`);
        return replyText;
      } catch (err) {
        console.warn(`[Gemini Attempt Failed] Model ${modelName} (Attempt ${attempt + 1}): ${err.message}`);

        if (attempt === MAX_RETRIES) {
          modelErrors.push(`${modelName}: ${err.message}`);
        }
      }
    }
  }

  throw new Error(`All Gemini Fallback Models Failed:\n${modelErrors.join('\n')}`);
}

/**
 * Send Chat Action (e.g. typing) to Telegram
 */
async function sendTelegramChatAction(token, chatId, action = 'typing', businessConnectionId = null) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable is missing.');

  const body = {
    chat_id: chatId,
    action: action
  };

  if (businessConnectionId) {
    body.business_connection_id = businessConnectionId;
  }

  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/**
 * Send Message to Telegram Chat with Markdown support and Plain-Text fallback
 */
async function sendTelegramMessage(token, chatId, text, businessConnectionId = null) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable is missing.');

  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };

  if (businessConnectionId) {
    body.business_connection_id = businessConnectionId;
  }

  // Primary Attempt: Send with Markdown formatting
  let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // Fallback: If Markdown parsing fails on Telegram's side, resend as plain text
  if (!res.ok) {
    console.warn('Telegram Markdown parse failed. Falling back to plain text sending...');
    delete body.parse_mode;

    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Telegram sendMessage HTTP ${res.status}: ${errBody}`);
    }
  }
}

/**
 * Dispatch Private Error Alert Message to Admin (ADMIN_CHAT_ID)
 */
async function sendAdminErrorAlert(error, env) {
  const adminId = env.ADMIN_CHAT_ID;
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!adminId || !token) {
    console.warn('Cannot dispatch error alert: ADMIN_CHAT_ID or TELEGRAM_BOT_TOKEN is not configured.');
    return;
  }

  const errorDetails = error?.stack || error?.message || String(error);
  const timestamp = new Date().toISOString();

  const alertMessage =
    `⚠️ **Telegram Bot Error Alert** ⚠️\n\n` +
    `**Timestamp:** \`${timestamp}\`\n\n` +
    `**Error Stack / Message:**\n` +
    `\`\`\`\n${errorDetails.slice(0, 3000)}\n\`\`\``;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminId,
        text: alertMessage,
        parse_mode: 'Markdown'
      })
    });

    if (!res.ok) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminId,
          text: `⚠️ Telegram Bot Error Alert ⚠️\n\nTimestamp: ${timestamp}\n\nError:\n${errorDetails.slice(0, 3000)}`
        })
      });
    }
  } catch (alertErr) {
    console.error('Failed to dispatch alert message to Admin:', alertErr);
  }
}

/**
 * Register Webhook Endpoint with Telegram API
 */
async function handleSetWebhook(originUrl, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return new Response('Error: TELEGRAM_BOT_TOKEN is missing in environment secrets.', { status: 400 });
  }

  const webhookUrl = `${originUrl}/`;
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'business_message']
    })
  });

  const data = await res.json();
  return new Response(JSON.stringify(data, null, 2), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}
