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
        `📚 Short Note & Worksheet ለማግኘት እና ለ Mobile App ምዝገባ 👉 <a href="https://t.me/SmartX_PreRegister_bot?start=ref_7471102761">@SmartX_PreRegister_bot</a> ይጫኑ!`;

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

  // 🛑 Conversation Closing Acknowledgement Rule:
  // If the previous message was already an assistant reply/closing and the user just says "tnx", "eshi", "thanks", "አመሰግናለሁ", etc.
  // without asking any new question, do NOT spam them with another message.
  let history = CHAT_HISTORIES.get(chatId) || [];
  if (!isGroup && isClosingAcknowledgement(userCaption, history)) {
    console.log(`User acknowledged with closing phrase "${userCaption}". Keeping conversation concluded peacefully.`);
    return;
  }

  // 🛡️ 3. Group Anti-Link & Protection System (Silent Deletion)
  if (isGroup) {
    const hasLink = checkMessageContainsLink(message, userCaption);
    if (hasLink) {
      const isAdminUser = await checkIfAdmin(env.TELEGRAM_BOT_TOKEN, chatId, senderId, senderUsername);
      if (!isAdminUser) {
        console.log(`🛡️ Anti-Link triggered in group ${chatId} by user ${senderId} (${senderUsername || senderName}). Silently deleting link...`);
        // Silently delete unauthorized link message immediately without sending any warning text
        await deleteTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, message.message_id);
        return; // Stop processing link message silently
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
  const rawAiResponse = await callGeminiWithFallback(contents, env.GEMINI_API_KEY, senderName, isGroup);
  const aiResponse = sanitizeBotResponse(rawAiResponse);

  // Step 7: Update Local Sliding Window Chat History
  history.push({ role: 'user', parts: userParts });
  history.push({ role: 'model', parts: [{ text: aiResponse }] });
  CHAT_HISTORIES.set(chatId, history.slice(-MAX_HISTORY_TURNS));

  // Step 8: Natural Scheduled Delay (~50-60 seconds / ~1 minute) before replying to direct chats
  if (!isGroup) {
    await delayWithTyping(env.TELEGRAM_BOT_TOKEN, chatId, 50000, businessConnectionId);
  }

  // Step 9: Check if AI response contains a Poll / Quiz structure
  const pollData = extractPollData(aiResponse);
  if (pollData && pollData.poll) {
    if (pollData.intro) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, pollData.intro, businessConnectionId);
    }
    const pollSent = await sendTelegramPoll(env.TELEGRAM_BOT_TOKEN, chatId, pollData.poll);
    if (!pollSent && !pollData.intro) {
      // Fallback: if poll failed to send, send raw message
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, aiResponse, businessConnectionId);
    }
  } else {
    // Send standard text message back to user via Telegram
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, aiResponse, businessConnectionId);
  }
}

/**
 * Natural human-like scheduled delay (~1 minute) with active typing status
 */
async function delayWithTyping(token, chatId, totalMs = 50000, businessConnectionId = null) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    await sendTelegramChatAction(token, chatId, 'typing', businessConnectionId);
    const remaining = totalMs - (Date.now() - start);
    const sleepTime = Math.min(remaining, 5000);
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

  // 2. Convert any Telegram links (like https://t.me/SmartX_PreRegister_bot...) into clean username @SmartX_PreRegister_bot
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

  const groupInstruction = isGroup
    ? `\n\n📊 GROUP QUESTION / QUIZ / POLL RULE (ግሩፕ ላይ ጥያቄ ሲጠየቅ):\n` +
      `- When users in a group ask a question, ask for a quiz, tag the bot with a STEM/school/general question, or say "ጥያቄ ጠይቀን" / "question":\n` +
      `- ALWAYS generate the response as an interactive Telegram Quiz/Poll in JSON format so members can vote and easily forward it to other groups/channels:\n` +
      `\`\`\`json\n` +
      `{\n` +
      `  "intro": "እንሆ የዛሬው ጥያቄ! 👇 መልሳችሁን ምረጡና ወደ ሌሎች ጓደኞቻችሁም forward አድርጉት!",\n` +
      `  "poll": {\n` +
      `    "question": "ጥያቄው እዚህ በአማርኛ ይፃፍ...",\n` +
      `    "options": ["A. ምርጫ አንድ", "B. ምርጫ ሁለት", "C. ምርጫ ሶስት", "D. ምርጫ አራት"],\n` +
      `    "correct_option_id": 0,\n` +
      `    "explanation": "ትክክለኛው መልስ ማብራሪያ በአጭሩ..."\n` +
      `  }\n` +
      `}\n` +
      `\`\`\`\n` +
      `- Make sure "options" has 2 to 4 clear choices, "correct_option_id" is the index (0, 1, 2, or 3) of the correct answer, and "explanation" is under 200 characters.\n`
    : '';

  const systemInstructionText =
    `You are the elite, warm, and highly professional personal assistant for Habtamu Yifiru (@smart_x_help / Smart x Ethiopian creator).\n\n` +
    `🛑 CRITICAL STRICT RULES:\n` +
    `1. PURE AMHARIC LANGUAGE ONLY (ሁሉም መልሶች በአማርኛ ብቻ ይሁኑ): Always respond in natural, warm, and clear Amharic (አማርኛ) for all users and questions.\n` +
    `2. PERSONALIZE GREETINGS WITH NAME: Always greet the user using their name${nameGreeting} (e.g. "ሰላም ${userName || ''}! 👋 እንኳን ደህና መጡ!").\n` +
    `3. ABSOLUTE STRICT BAN ON AI IDENTIFIERS: NEVER say "I am an AI", "እኔ AI ነኝ", or mention any AI company. Always speak as a real, helpful human personal assistant for Habtamu Yifiru.\n` +
    `4. REPLY TO EVERY MESSAGE: Always provide an active, helpful, and contextual reply in Amharic to every incoming message or inquiry.\n` +
    `5. ABUSIVE / OFFENSIVE LANGUAGE RULE (የሚሳደብ ካለ አይመልስ by ይበል): If a user uses insults, bad words, vulgarity, or abusive language, do NOT help or argue. Reply strictly with "ደህና ሁኑ! 👋" and end the conversation immediately.\n` +
    `6. ABSOLUTE CONCISE RESPONSES: Keep every response short, clean, direct, and decorated with tasteful emojis 😊. Maximum 2-4 lines or clean bullet steps. No giant essays.\n` +
    `7. CHAT HISTORY CONTINUITY: Always read and respect the previous chat history naturally.\n\n` +
    groupInstruction +
    `📚 INBOX SCENARIO & REGISTRATION STEPS (Short Notes, Worksheets & App Release):\n` +
    `- CONTEXT: Habtamu posts on groups: "short note and worksheet የምትፈልጉ በ inbox አውሩን".\n` +
    `- When users message in inbox (e.g., "እኔ እፈልጋለው", "hi", "worksheet", "short note", "መዝግቡኝ", "እንዴት ላግኝ", "ጥያቄ አለኝ", or any related request):\n` +
    `  1. Greet them warmly with their name (e.g. "ሰላም ${userName || ''}! 👋 እንኳን ደህና መጡ!")\n` +
    `  2. Tell them clearly: Short note እና Worksheet ለማግኘት እንዲሁም ለአዲሱ Mobile App ለመመዝገብ ከታች ያለውን "🚀 ምዝገባ ጀምር (Start Bot)" button ይጫኑ ወይም @SmartX_PreRegister_bot ላይ ይግቡ።\n` +
    `  3. Give them the clear, clean step-by-step guidance:\n` +
    `     1️⃣ @SmartX_PreRegister_bot ገብተው "Start" ይበሉ\n` +
    `     2️⃣ ቋንቋ እና የክፍል ደረጃዎን (Grade 9 - 12) ይምረጡ\n` +
    `     3️⃣ የፍላጎት ማረጋገጫ 5 አጫጭር ጥያቄዎችን ይመልሱ\n` +
    `     4️⃣ የቴሌግራም ቻናላችንን Join ያድርጉ\n` +
    `  4. Explain about Mobile App APK Release: አዲሱ Smart x Ethiopian Mobile Application (.apk file) በይፋ መስከረም 5 ይለቀቃል! Notification On አድርገው ይጠብቁ።\n` +
    `  5. SCREENSHOT RULE: Do NOT ask for screenshots by default. Only tell them: "የከበዳችሁ ወይም ያልገባችሁ ደረጃ ካለ የ Screen Shot ምስል ላኩልን፣ በደስታ እናግዛችኋለን! 😊"\n` +
    `  6. IMPORTANT FORMATTING RULE: In your message text, NEVER write raw URLs like "https://t.me/...". ALWAYS write the clean username "@SmartX_PreRegister_bot" instead, so the message stays neat and human-like.\n` +
    `  7. STRICT BAN ON GROUP LINKS: NEVER mention, share, or write any Telegram group link. Do NOT mention @SmartX_Ethio or any group. Registration is only via @SmartX_PreRegister_bot.\n\n` +
    `📞 PHONE NUMBER & CONTACTS RULE:\n` +
    `- If a user asks for phone number, direct call, or direct contact, provide: 0992480372 (ወይም በ @smart_x_help ያግኙን).\n\n` +
    `🎙️ VISION, TROUBLESHOOTING & MULTIMODAL:\n` +
    `1. TROUBLESHOOTING SCREENSHOTS: When a user sends a screenshot of any step where they got stuck or confused, analyze the exact screen/button/prompt, tell them what went wrong or what to click next in clear Amharic, and guide them to finish.\n` +
    `2. GENERAL IMAGES: If an image is a question, worksheet, code snippet, or document, provide a clean, accurate, and direct explanation in Amharic.\n` +
    `3. VOICE / AUDIO NOTES: Seamlessly answer voice notes directly in Amharic without commenting that it was audio.\n\n` +
    `⚠️ SCREENSHOT / FORWARD WARNING RULE:\n` +
    `- If a user asks about forwarding, leaking, or screenshotting chat content outside, politely remind them in Amharic:\n` +
    `  "⚠️ *ለደህንነት ሲባል የዚህ chat መረጃዎች Forward ማድረግ ወይም Screenshot ማንሳት የተከለከሉ ናቸው። ለተጨማሪ መረጃ በ 0992480372 ያግኙን!*"\n\n` +
    `🧠 TONE & PERSONALITY (HUMAN-LIKE):\n` +
    `- Speak warmly, politely, calmly, and naturally like a real professional human assistant in Amharic.\n` +
    `- Avoid robotic walls of text or repetitive boilerplate. Be direct, clear, and helpful.\n` +
    `- Always end with a polite, natural follow-up question or helpful closing.\n\n` +
    `📞 OFFICIAL CONTACT DETAILS:\n` +
    `Only share when requested or relevant:\n` +
    `- Telegram Username: @smart_x_help\n` +
    `- Pre-Registration Bot: @SmartX_PreRegister_bot\n` +
    `- Phone Number: 0992480372\n` +
    `- YouTube: Smart X Ethiopia\n` +
    `- App Release Date: መስከረም 5 (Smart x Ethiopian Mobile App .apk file)\n\n` +
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
async function sendTelegramMessage(token, chatId, text, businessConnectionId = null) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN environment variable is missing.');

  const htmlText = convertMarkdownToTelegramHtml(text);
  const inlineMarkup = getRegistrationInlineMarkup(text);

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
      allowed_updates: ['message', 'business_message']
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
 * when previous interaction was already completed by assistant.
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
  if (text.length > 25 || text.includes('?') || text.includes('？') || text.includes('እንዴት') || text.includes('ምን')) {
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
    'እናመሰግናለን',
    'ተመስገን',
    'ደህና ሁን',
    'ደህና ሁኑ',
    'ሰላም ሁን',
    'ሰላም ሁኑ',
    'መልካም ቀን',
    'መልካም ምሽት'
  ]);

  if (closingWords.has(clean)) {
    // If we have history and the assistant already replied in previous turns, conclude gracefully
    if (history && history.length >= 2) {
      return true;
    }
  }

  return false;
}
