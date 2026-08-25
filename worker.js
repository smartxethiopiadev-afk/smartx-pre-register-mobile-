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
const BUTTON_SENT_CHATS = new Set();
const THANKS_COUNT = new Map();
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
        // Execute asynchronously using ctx.waitUntil so Telegram receives 200 OK immediately
        // while the 1-minute scheduled delay executes smoothly in the background
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(handleTelegramUpdate(update, env, ctx));
        } else {
          await handleTelegramUpdate(update, env, ctx);
        }
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
async function handleTelegramUpdate(update, env, ctx) {
  // 🌟 Handle chat_member event (when a user joins a supergroup)
  if (update.chat_member) {
    const cm = update.chat_member;
    const chat = cm.chat;
    const isGrp = chat?.type === 'group' || chat?.type === 'supergroup';
    const isNewJoin =
      (cm.new_chat_member?.status === 'member' || cm.new_chat_member?.status === 'restricted') &&
      cm.old_chat_member?.status !== 'member' &&
      cm.old_chat_member?.status !== 'restricted';

    if (isGrp && isNewJoin) {
      const user = cm.new_chat_member.user;
      if (user && !user.is_bot) {
        const memberName = user.first_name || user.username || 'ውድ አባል';
        const welcomeText =
          `👋 ሰላም <b>${memberName}</b>! እንኳን ወደ <b>Smart x Ethiopian</b> ግሩፕ በደህና መጡ! ✨\n\n` +
          `📚 Short Note & Worksheet ለማግኘት እና ለ Mobile App ምዝገባ 👉 @SmartX_PreRegister_bot ይጫኑ!`;

        const sentWelcome = await sendSimpleTelegramMessage(env.TELEGRAM_BOT_TOKEN, chat.id, welcomeText);
        if (sentWelcome && sentWelcome.message_id) {
          const delayedDelete = new Promise((resolve) => setTimeout(resolve, 10000)).then(async () => {
            await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chat.id, sentWelcome.message_id);
          });
          if (ctx && ctx.waitUntil) {
            ctx.waitUntil(delayedDelete);
          }
        }
      }
    }
    return;
  }

  const message = update.business_message || update.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const chatType = message.chat?.type || 'private';
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const businessConnectionId = message.business_connection_id || update.business_connection_id;
  if (!chatId) return;

  const senderId = message.from?.id;
  const senderName = message.from?.first_name || message.chat?.first_name || '';
  const senderUsername = message.from?.username || message.chat?.username || '';

  // 🌟 1. Handle New Chat Member Joining Group (Welcome Message & Auto-Delete)
  if (isGroup && message.new_chat_members && message.new_chat_members.length > 0) {
    // Delete service message "X joined the group" to keep chat pristine
    await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, message.message_id);

    for (const newMember of message.new_chat_members) {
      if (newMember.is_bot) continue;
      const memberName = newMember.first_name || newMember.username || 'ውድ አባል';
      const welcomeText =
        `👋 ሰላም <b>${memberName}</b>! እንኳን ወደ <b>Smart x Ethiopian</b> ግሩፕ በደህና መጡ! ✨\n\n` +
        `📚 Short Note & Worksheet ለማግኘት እና ለ Mobile App ምዝገባ 👉 @SmartX_PreRegister_bot ይጫኑ!`;

      const sentWelcome = await sendSimpleTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, welcomeText);
      if (sentWelcome && sentWelcome.message_id) {
        // Auto-delete welcome message after 10 seconds to keep group clean
        const delayedDelete = new Promise((resolve) => setTimeout(resolve, 10000)).then(async () => {
          await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, sentWelcome.message_id);
        });
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(delayedDelete);
        }
      }
    }
    return;
  }

  // 🧹 2. Handle Member Leaving Group (Delete Service Message)
  if (isGroup && message.left_chat_member) {
    await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, message.message_id);
    return;
  }

  let userCaption = message.text || message.caption || '';

  // 🛑 Conversation Closing Acknowledgement (Code 08) & Abusive Language (Code 05) Pre-Filters:
  let history = CHAT_HISTORIES.get(chatId) || [];
  if (!isGroup && isClosingAcknowledgement(userCaption, history)) {
    const previousThanks = THANKS_COUNT.get(chatId) || 0;
    if (previousThanks >= 1) {
      console.log(`[Code 08] User sent 2nd closing phrase "${userCaption}". Concluding in complete silence.`);
      return;
    }
    // First thanks: respond warmly once, then increment count
    THANKS_COUNT.set(chatId, 1);
    console.log(`[Code 08] User sent 1st closing phrase "${userCaption}". Replying politely once.`);
    await delayWithHumanPacing(env.TELEGRAM_BOT_TOKEN, chatId, businessConnectionId);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, 'ምንም አይደለም! በደስታ ነው 😊 መልካም የትምህርት ጊዜ! ✨', businessConnectionId, false);
    return;
  }
  if (!isGroup && isAbusiveMessage(userCaption)) {
    console.log(`[Code 05] User message contained abusive words. Concluding conversation in silence.`);
    return;
  }

  // 🛡️ 3. Group Anti-Link & Protection System (Strictly Silent Deletion)
  if (isGroup) {
    const hasLink = checkMessageContainsLink(message, userCaption);
    if (hasLink) {
      const isAdminUser = await checkIfAdmin(env.TELEGRAM_BOT_TOKEN, chatId, senderId, senderUsername);
      if (!isAdminUser) {
        console.log(`🛡️ Anti-Link triggered in group ${chatId} by user ${senderId} (${senderUsername || senderName}). Silently deleting link without any warning...`);
        // Silently delete unauthorized link message immediately - DO NOT SEND ANY WARNING OR TEXT
        await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, message.message_id);
        return; // Stop processing link message completely
      }
    }
  }

  // In groups, only respond if someone mentions bot, replies to bot, or asks a direct inquiry
  if (isGroup) {
    const isBotMentioned = checkIsBotMentioned(message, userCaption);
    const isReplyToBot = message.reply_to_message?.from?.is_bot;
    if (!isBotMentioned && !isReplyToBot) {
      // Allow normal member conversations without AI spamming
      return;
    }
  }

  const userParts = [];

  // Step 1: In groups, send short typing indicator
  if (isGroup) {
    await sendTelegramChatAction(env.TELEGRAM_BOT_TOKEN, chatId, 'typing', businessConnectionId);
  }

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
  const rawAiResponse = await callGeminiWithFallback(contents, env.GEMINI_API_KEY, senderName, isGroup);
  const trimmedCode = (rawAiResponse || '').trim();

  // 🛑 Silence Codes:
  // Code 08: User closed or thanked (TNX, thanks, eshi, etc.) -> Total silence
  // Code 05: Abusive / offensive message -> Total silence
  if (trimmedCode === '08' || trimmedCode.startsWith('08') || trimmedCode === '05' || trimmedCode.startsWith('05')) {
    console.log(`[AI Silent Code ${trimmedCode}] Keeping conversation concluded in complete silence.`);
    history.push({ role: 'user', parts: userParts });
    history.push({ role: 'model', parts: [{ text: trimmedCode }] });
    CHAT_HISTORIES.set(chatId, history.slice(-MAX_HISTORY_TURNS));
    return;
  }

  const aiResponse = sanitizeBotResponse(rawAiResponse);

  // Step 7: Update Local Sliding Window Chat History
  history.push({ role: 'user', parts: userParts });
  history.push({ role: 'model', parts: [{ text: aiResponse }] });
  CHAT_HISTORIES.set(chatId, history.slice(-MAX_HISTORY_TURNS));

  // 🔘 Button Rule: The registration button is sent ONLY ONCE on the first introductory message
  // If the conversation already has prior bot messages or button was already sent, do NOT attach button.
  const hadPreviousModelReply = history.slice(0, -2).some(turn => turn.role === 'model' && turn.parts?.[0]?.text !== '08' && turn.parts?.[0]?.text !== '05');
  const shouldAttachButton = !isGroup && !hadPreviousModelReply && !BUTTON_SENT_CHATS.has(chatId);
  if (shouldAttachButton) {
    BUTTON_SENT_CHATS.add(chatId);
  }

  // Step 8: Natural Scheduled Delay (~30-45 seconds) before replying to direct chats
  // Phase 1: 15-20s reading pause (No typing shown, simulates user reading incoming message)
  // Phase 2: 10-15s typing phase (Shows "typing..." status naturally)
  if (!isGroup) {
    await delayWithHumanPacing(env.TELEGRAM_BOT_TOKEN, chatId, businessConnectionId);
  }

  // Step 9: Send text message back to user via Telegram (Telegram rate limit safe)
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, aiResponse, businessConnectionId, shouldAttachButton);
}

/**
 * Natural human-like scheduled delay:
 * 1. Silent Reading Period (~18 seconds) - NO typing action sent
 * 2. Active Typing Period (~12 seconds) - Sends typing action
 * Complies with Telegram Anti-Spam / Rate-limiting policies and prevents account bans
 */
async function delayWithHumanPacing(token, chatId, businessConnectionId = null) {
  // Phase 1: Silent reading delay (18 seconds)
  await new Promise((resolve) => setTimeout(resolve, 18000));

  // Phase 2: Active typing delay (12 seconds)
  const typingStart = Date.now();
  const typingDuration = 12000;
  while (Date.now() - typingStart < typingDuration) {
    await sendTelegramChatAction(token, chatId, 'typing', businessConnectionId);
    const remaining = typingDuration - (Date.now() - typingStart);
    const sleepTime = Math.min(remaining, 4000);
    if (sleepTime <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, sleepTime));
  }
}

/**
 * Clean & sanitize response to strictly remove any group links and raw URLs from text
 */
function sanitizeBotResponse(text) {
  if (!text) return '';
  let cleaned = text;

  // 1. Remove any mentions of group link, SmartX_Ethio, or group registration steps
  cleaned = cleaned.replace(/https?:\/\/t\.me\/SmartX_Ethio[^\s\)]*/gi, '');
  cleaned = cleaned.replace(/@SmartX_Ethio/gi, '');
  cleaned = cleaned.replace(/•?\s*ደረጃ\s*5[^\n]*የውይይት[^\n]*/gi, '');
  cleaned = cleaned.replace(/•?\s*ደረጃ\s*5[^\n]*ግሩፕ[^\n]*/gi, '');

  // 2. Strip raw referral links (e.g., https://t.me/SmartX_PreRegister_bot?start=ref_...) and replace with clean @SmartX_PreRegister_bot
  cleaned = cleaned.replace(/https?:\/\/t\.me\/SmartX_PreRegister_bot\?[^\s\)]*/gi, '@SmartX_PreRegister_bot');
  cleaned = cleaned.replace(/https?:\/\/t\.me\/SmartX_PreRegister_bot[^\s\)]*/gi, '@SmartX_PreRegister_bot');
  cleaned = cleaned.replace(/https?:\/\/t\.me\/([a-zA-Z0-9_]+)[^\s\)]*/gi, '@$1');

  // 3. Strip any other raw URLs (https://... or http://...) so text stays 100% link-free and clean
  cleaned = cleaned.replace(/https?:\/\/[^\s\)]+/gi, '');

  // 4. Clean brackets or artifacts left over from URL removal
  cleaned = cleaned.replace(/\(\s*@SmartX_PreRegister_bot\s*\)/gi, '@SmartX_PreRegister_bot');
  cleaned = cleaned.replace(/\(\s*\)/g, '');
  cleaned = cleaned.replace(/\[\s*\]/g, '');

  // 5. Clean empty lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
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
async function callGeminiWithFallback(contents, apiKey, userName = '', isGroup = false) {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is missing.');
  }

  const nameGreeting = userName ? ` (User's Name: "${userName}")` : '';

  const systemInstructionText =
    `You are the official, warm, and highly professional student support assistant for Smart X Ethiopia (@smart_x_help / Smart X Ethiopian Mobile Academy).\n\n` +
    `🛑 CRITICAL STRICT PROTOCOL RULES:\n` +
    `1. CONVERSATION CLOSING & THANKS RULE (ኮድ 08 - ሁለተኛ ምስጋና ላይ ፍፁም ዝምታ):\n` +
    `   - If the user sends a second thank you / closing acknowledgement, or says "TNX", "thanks", "eshi", "ok", "bye" after you already said "ምንም አይደለም! በደስታ ነው 😊":\n` +
    `     👉 YOUR ENTIRE OUTPUT MUST BE STRICTLY: 08\n` +
    `   - For the FIRST thank you, you may give a very short warm reply (e.g., "ምንም አይደለም! በደስታ ነው 😊 መልካም የትምህርት ጊዜ! ✨").\n\n` +
    `2. ABUSIVE / OFFENSIVE LANGUAGE RULE (ኮድ 05 - ስድብ):\n` +
    `   If the user uses insults, bad words, vulgarity, curses, or abusive language:\n` +
    `   👉 YOUR ENTIRE OUTPUT MUST BE STRICTLY: 05\n` +
    `   (Do not output any words, punctuation, or emojis, just "05").\n\n` +
    `3. PURE AMHARIC LANGUAGE ONLY (ሁሉም መልሶች በአማርኛ ብቻ ይሁኑ): Always respond in natural, warm, and clear Amharic (አማርኛ) for all regular inquiries.\n` +
    `4. PERSONALIZE GREETINGS WITH NAME: Greet the user using their name${nameGreeting} (e.g. "ሰላም ${userName || ''}! 👋 እንኳን ወደ Smart X Ethiopia በደህና መጡ!").\n` +
    `5. STRICT IDENTITY RULE (ስለ Smart X Ethiopia ብቻ ማውራት):\n` +
    `   - ALWAYS speak solely as "የ Smart X Ethiopia ድጋፍ ሰጪ" (Smart X Ethiopian Support).\n` +
    `   - DO NOT mention personal names like "ሀብታሙ" / "የሀብታሙ ረዳት ነኝ" or anything similar. You represent Smart X Ethiopia only.\n` +
    `   - NEVER say "I am an AI", "እኔ AI ነኝ", or mention any AI company.\n\n` +
    `6. ABSOLUTE BAN ON GROUP DATA & GROUP LINKS:\n` +
    `   - NEVER share, mention, or write ANY Telegram group link or group username (e.g., do NOT mention SmartX_Ethio, "ግሩፕ ተቀላቀሉ", or any group).\n` +
    `   - All student guidance is ONLY focused on @SmartX_PreRegister_bot.\n\n` +
    `7. CONCISE & CLEAN RESPONSES: Keep every response short, clean, direct, and decorated with tasteful emojis 😊. Maximum 2-4 lines or clean bullet steps. No giant essays.\n` +
    `8. SUBSEQUENT CHAT TURNS & FOLLOW-UPS (ከመጀመሪያው መልስ በኋላ የሚደረግ ውይይት):\n` +
    `   - If this is a follow-up message (you already gave the introduction in chat history), DO NOT repeat the full 4-step registration block or long greeting again.\n` +
    `   - Answer the user's specific question or confusion in 1 to 2 very short, direct lines.\n` +
    `   - If they need guidance on a specific step, show ONLY that single step clearly and briefly.\n` +
    `9. STRICT BAN ON RAW / REFERRAL LINKS IN NORMAL MESSAGES:\n` +
    `   - NEVER write full URLs, referral links (?start=ref_...), or raw https links in the message body.\n` +
    `   - ALWAYS refer to the bot as "@SmartX_PreRegister_bot" in normal message text so the conversation looks natural and complies with Telegram's spam policy.\n` +
    `10. TELEGRAM POLICY & ACCOUNT SAFETY (የቴሌግራም ፖሊሲ ጥበቃ):\n` +
    `   - Always sound like an attentive human support team member.\n` +
    `   - Never flood or send repetitive spam messages to avoid account flagging or restrictions.\n\n` +
    `📚 INBOX SCENARIO & REGISTRATION STEPS (Short Notes, Worksheets & App Release):\n` +
    `- CONTEXT: Student reaches out regarding Short notes, worksheets, and Mobile App pre-registration.\n` +
    `- When users message in inbox (e.g., "እኔ እፈልጋለው", "hi", "worksheet", "short note", "መዝግቡኝ", "እንዴት ላግኝ", "ጥያቄ አለኝ", or any related request):\n` +
    `  1. Greet them warmly: "ሰላም ${userName || ''}! 👋 እንኳን ወደ Smart X Ethiopia በደህና መጡ!"\n` +
    `  2. Tell them clearly: Short note እና Worksheet ለማግኘት እንዲሁም ለአዲሱ Mobile App ለመመዝገብ @SmartX_PreRegister_bot ላይ ይግቡ።\n` +
    `  3. Give them the clear, clean step-by-step guidance:\n` +
    `     1️⃣ @SmartX_PreRegister_bot ገብተው "Start" ይበሉ\n` +
    `     2️⃣ ቋንቋ እና የክፍል ደረጃዎን (Grade 9 - 12) ይምረጡ\n` +
    `     3️⃣ የፍላጎት ማረጋገጫ 5 አጫጭር ጥያቄዎችን ይመልሱ\n` +
    `     4️⃣ የቴሌግራም ቻናላችንን Join ያድርጉ\n` +
    `  4. Explain about Mobile App APK Release: አዲሱ Smart x Ethiopian Mobile Application (.apk file) በይፋ መስከረም 5 ይለቀቃል! Notification On አድርገው ይጠብቁ።\n` +
    `  5. SCREENSHOT RULE: Do NOT ask for screenshots by default. Only tell them: "የከበዳችሁ ወይም ያልገባችሁ ደረጃ ካለ የ Screen Shot ምስል ላኩልን፣ በደስታ እናግዛችኋለን! 😊"\n` +
    `  6. FORMATTING: NEVER write raw URLs like "https://t.me/...". ALWAYS write the clean username "@SmartX_PreRegister_bot".\n\n` +
    `📞 CONTACTS RULE:\n` +
    `- If a user asks for phone number, direct call, or direct contact, provide: 0992480372 (ወይም በ @smart_x_help ያግኙን).\n\n` +
    `🎙️ VISION, TROUBLESHOOTING & MULTIMODAL:\n` +
    `1. TROUBLESHOOTING SCREENSHOTS: When a user sends a screenshot of any step where they got stuck or confused, analyze the exact screen/button/prompt, tell them what went wrong or what to click next in clear Amharic, and guide them to finish.\n` +
    `2. GENERAL IMAGES: If an image is a question, worksheet, code snippet, or document, provide a clean, accurate, and direct explanation in Amharic.\n` +
    `3. VOICE / AUDIO NOTES: Seamlessly answer voice notes directly in Amharic without commenting that it was audio.\n\n` +
    `🧠 TONE & PERSONALITY (HUMAN-LIKE):\n` +
    `- Speak warmly, politely, calmly, and naturally like a real professional human assistant in Amharic.\n` +
    `- Avoid robotic walls of text or repetitive boilerplate. Be direct, clear, and helpful.\n\n` +
    `🛑 OUTPUT FORMATTING CLEANLINESS:\n` +
    `- Output ONLY the final raw chat text meant for the user (or "08" / "05" when applicable).\n` +
    `- NEVER output debug logs, character counts, internal reasoning, or quotation marks.`;

  const payload = {
    contents: contents,
    systemInstruction: {
      parts: [{ text: systemInstructionText }]
    },
    generationConfig: {
      temperature: 0.5,
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
 * Convert Markdown text to Telegram-supported HTML safely without breaking usernames or links
 */
function convertMarkdownToTelegramHtml(text) {
  if (!text) return '';

  // Escape basic HTML entities
  let escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold: **text** -> <b>text</b>
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

  // Inline Code: `text` -> <code>text</code>
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

  return escaped;
}

/**
 * Generate Inline Keyboard with Start Bot button for registration / bot flow
 */
function getRegistrationInlineMarkup(text) {
  const lower = (text || '').toLowerCase();
  const shouldAttachButton =
    lower.includes('smartx') ||
    lower.includes('preregister') ||
    lower.includes('bot') ||
    lower.includes('ምዝገባ') ||
    lower.includes('ደረጃ') ||
    lower.includes('short note') ||
    lower.includes('worksheet') ||
    lower.includes('መስከረም') ||
    lower.includes('start') ||
    lower.includes('ሰላም') ||
    lower.includes('hi');

  if (shouldAttachButton) {
    return {
      inline_keyboard: [
        [
          {
            text: '🚀 ምዝገባ ጀምር (Start Bot) 👉',
            url: 'https://t.me/SmartX_PreRegister_bot?start=ref_7471102761'
          }
        ]
      ]
    };
  }
  return null;
}

/**
 * Send Message to Telegram Chat with HTML support, Start Bot button, and robust fallback
 */
async function sendTelegramMessage(token, chatId, text, businessConnectionId = null, attachButton = false) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable is missing.');

  const htmlText = convertMarkdownToTelegramHtml(text);
  const inlineMarkup = attachButton ? getRegistrationInlineMarkup(text) : null;

  const body = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    disable_web_page_preview: true
  };

  if (inlineMarkup) {
    body.reply_markup = inlineMarkup;
  }

  if (businessConnectionId) {
    body.business_connection_id = businessConnectionId;
  }

  // Primary Attempt: Send with HTML formatting, inline button, and link previews disabled
  let res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  // Fallback 1: If HTML parse fails, resend as plain text
  if (!res.ok) {
    console.warn('Telegram HTML parse failed. Falling back to plain text sending...');
    delete body.parse_mode;
    body.text = text; // original plain text

    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // Fallback 2: If inline_keyboard fails in any specific client/mode, retry without reply_markup
    if (!res.ok && body.reply_markup) {
      console.warn('Telegram reply_markup failed. Retrying without reply_markup...');
      delete body.reply_markup;

      res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Telegram sendMessage HTTP ${res.status}: ${errBody}`);
    }
  }
}

/**
 * Extract Poll / Quiz JSON from Gemini response if present
 */
function extractPollData(text) {
  if (!text) return null;

  try {
    // Check if whole text or fenced code block is JSON
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    const rawJson = jsonMatch[1] || text;
    const parsed = JSON.parse(rawJson);
    if (parsed && parsed.poll && parsed.poll.question && Array.isArray(parsed.poll.options)) {
      return parsed;
    }
  } catch (_) {
    // If not strict JSON, look for embedded {"poll": ...}
    const startIdx = text.indexOf('{"poll"');
    const altStartIdx = text.indexOf('{\n  "poll"');
    const idx = startIdx !== -1 ? startIdx : altStartIdx;
    if (idx !== -1) {
      try {
        const endIdx = text.lastIndexOf('}');
        if (endIdx > idx) {
          const jsonSub = text.substring(idx, endIdx + 1);
          const parsed = JSON.parse(jsonSub);
          if (parsed && parsed.poll) {
            const intro = text.substring(0, idx).trim();
            return { intro, poll: parsed.poll };
          }
        }
      } catch (__) {}
    }
  }
  return null;
}

/**
 * Send interactive Telegram Native Quiz / Poll to Chat or Group
 */
async function sendTelegramPoll(token, chatId, pollData) {
  if (!token || !chatId || !pollData) return null;

  const rawOptions = Array.isArray(pollData.options) ? pollData.options : [];
  const options = rawOptions
    .map((opt) => (typeof opt === 'string' ? opt : String(opt || '')).trim())
    .filter(Boolean);

  if (options.length < 2) return null;

  const question = String(pollData.question || 'የዛሬው ጥያቄ').trim().slice(0, 300);
  const correctOptionId =
    typeof pollData.correct_option_id === 'number' &&
    pollData.correct_option_id >= 0 &&
    pollData.correct_option_id < options.length
      ? pollData.correct_option_id
      : 0;

  const explanation = pollData.explanation
    ? String(pollData.explanation).trim().slice(0, 200)
    : undefined;

  const body = {
    chat_id: chatId,
    question: question,
    options: options.slice(0, 10),
    type: 'quiz',
    correct_option_id: correctOptionId,
    is_anonymous: false
  };

  if (explanation) {
    body.explanation = explanation;
  }

  try {
    let res = await fetch(`https://api.telegram.org/bot${token}/sendPoll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      // Fallback: If Quiz mode fails due to explanation/formatting constraints, send as regular poll
      delete body.correct_option_id;
      delete body.explanation;
      body.type = 'regular';

      res = await fetch(`https://api.telegram.org/bot${token}/sendPoll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    }

    if (res.ok) {
      const data = await res.json();
      return data.result;
    } else {
      const errText = await res.text();
      console.warn('sendPoll error response:', errText);
    }
  } catch (err) {
    console.error('Error dispatching Telegram sendPoll:', err);
  }

  return null;
}

/**
 * Check if a message contains links, URLs, invites, or domain promotions
 */
function checkMessageContainsLink(message, text = '') {
  // Check Telegram entities
  const entities = [...(message.entities || []), ...(message.caption_entities || [])];
  for (const entity of entities) {
    if (entity.type === 'url' || entity.type === 'text_link') {
      return true;
    }
  }

  // Regex check for links, telegram handles, or domains
  const linkRegex = /(https?:\/\/|t\.me\/|telegram\.me\/|telegram\.dog\/|joinchat\/|bit\.ly\/|www\.)[^\s]+/i;
  if (linkRegex.test(text)) {
    return true;
  }

  return false;
}

/**
 * Check if user is an Administrator, Creator, or Owner (Habtamu)
 */
async function checkIfAdmin(token, chatId, userId, username = '') {
  // Check known admin identifiers
  const cleanUsername = (username || '').replace('@', '').toLowerCase();
  if (cleanUsername === 'smart_x_help' || String(userId) === '7471102761') {
    return true;
  }

  if (!userId || !token) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        user_id: userId
      })
    });

    if (res.ok) {
      const data = await res.json();
      const status = data.result?.status;
      return status === 'creator' || status === 'administrator';
    }
  } catch (err) {
    console.error('Error checking chat member admin status:', err);
  }

  return false;
}

/**
 * Check if bot is mentioned in a group message
 */
function checkIsBotMentioned(message, text = '') {
  const entities = message.entities || [];
  for (const entity of entities) {
    if (entity.type === 'mention') {
      return true;
    }
  }
  return text.toLowerCase().includes('@smart') || text.includes('/start') || text.includes('/help');
}

/**
 * Delete a message from a Telegram chat/group
 */
async function deleteTelegramMessage(token, chatId, messageId) {
  if (!token || !chatId || !messageId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId
      })
    });
    return res.ok;
  } catch (err) {
    console.error('Failed to delete Telegram message:', err);
    return false;
  }
}

/**
 * Send a simple plain/HTML message without inline keyboards
 */
async function sendSimpleTelegramMessage(token, chatId, htmlText) {
  if (!token || !chatId) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        disable_web_page_preview: true
      })
    });
    if (res.ok) {
      const data = await res.json();
      return data.result;
    }
  } catch (err) {
    console.error('Failed to send simple message:', err);
  }
  return null;
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
      allowed_updates: ['message', 'business_message', 'chat_member']
    })
  });

  const data = await res.json();
  return new Response(JSON.stringify(data, null, 2), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Check if the user message is a polite closing or acknowledgement (e.g. TNX, እሺ, Thanks, Ok, Bye)
 */
function isClosingAcknowledgement(text, history) {
  if (!text || typeof text !== 'string') return false;

  // Clean and normalize text
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?:;🙏👍👋😊🙌❤️✨]/g, '')
    .trim();

  // If text is too long or contains a question mark, it's a real question or conversation
  if (text.length > 30 || text.includes('?') || text.includes('？') || text.includes('እንዴት') || text.includes('ምን')) {
    return false;
  }

  const closingWords = new Set([
    'tnx',
    'thx',
    'thanks',
    'thank you',
    'thank u',
    'tq',
    'ty',
    'eshi',
    'ishi',
    'ok',
    'okay',
    'k',
    'kk',
    'bye',
    'bye bye',
    'goodbye',
    'cya',
    'እሺ',
    'እሽ',
    'አመሰግናለሁ',
    'እናመሰግናለን',
    'አመሰግናለው',
    'ተመስገን',
    'ደህና ሁን',
    'ደህና ሁኑ',
    'ሰላም ሁን',
    'ሰላም ሁኑ',
    'መልካም ቀን',
    'መልካም ምሽት'
  ]);

  return closingWords.has(clean);
}

/**
 * Check if the message contains insults, vulgarity, or abusive keywords (Code 05)
 */
function isAbusiveMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().trim();
  const abusiveList = ['fuck', 'shit', 'bitch', 'asshole', 'idiot', 'stupid', 'bastard', 'dick', 'ውሻ', 'ጅል', 'ደደብ', 'አህያ', 'ስድ', 'ሸርሙጣ', 'ሌባ', 'የውሻ ልጅ', 'ፈሳም'];
  for (const word of abusiveList) {
    if (clean.includes(word)) return true;
  }
  return false;
}
