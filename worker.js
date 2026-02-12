/**
 * WorkerLarkBot - v11.4
 */
const CONFIG = {
  PRIMARY_MODEL: "gemini-flash-latest", 
  FALLBACK_MODEL: "gemma-3-12b-it",
  BASE_URL_LARK: "https://open.larksuite.com/open-apis",
  BASE_URL_GOOGLE: "https://generativelanguage.googleapis.com/v1beta",
  TEMPERATURE: 0.5
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot Online");
    const payload = await request.json();

    if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });

    if (payload.header?.event_type === "im.message.receive_v1") {
      const { message_id, content } = payload.event.message;
      const userQuery = JSON.parse(content).text;
      const eventTimeMs = parseInt(payload.header.create_time);
      const userDateTime = new Date(eventTimeMs).toLocaleString();

      ctx.waitUntil(this.processWorkflow(message_id, userQuery, userDateTime, env));
      return Response.json({ code: 0, msg: "success" });
    }
    return new Response("OK");
  },

  async processWorkflow(messageId, userQuery, userDateTime, env) {
    try {
      const [appId, appSecret, apiKey] = await Promise.all([
        env.LARK_APP_ID.get(),
        env.LARK_APP_SECRET.get(),
        env.GEMINI_API_KEY.get()
      ]);

      const token = await this.getLarkToken(appId, appSecret);
      const systemRule = `[SYSTEM RULE: User local time and date: ${userDateTime}. Respond in the same language as the user. Focus on the user query. Use Lark Markdown but avoid using the asterisk '*' character; use __bold__ for bold and - for bullets to organize content.]\n\nUser Query: `;

      await this.addReaction(messageId, "THINKING", token);

      // Attempt Primary
      let aiText = await this.generateAIResponse(CONFIG.PRIMARY_MODEL, `${systemRule}${userQuery}`, apiKey);
      
      // Fallback Logic: Check for Quota or Regional Block
      if (aiText === "FALLBACK_REQUIRED") {
        console.warn(`[DEBUG] Primary model ${CONFIG.PRIMARY_MODEL} failed (Quota/Location). Switching to fallback.`);
        aiText = await this.generateAIResponse(CONFIG.FALLBACK_MODEL, `${systemRule}${userQuery}`, apiKey);
      }

      await this.sendLarkCard(messageId, aiText, token);
      await this.addReaction(messageId, "DONE", token);

    } catch (err) {
      console.error(`[CRITICAL ERROR]: ${err.message}`);
    }
  },

  async generateAIResponse(modelName, fullPrompt, apiKey) {
    const url = `${CONFIG.BASE_URL_GOOGLE}/models/${modelName}:generateContent?key=${apiKey}`;
    
    console.log(`[DEBUG] Requesting Model: ${modelName}`);
    console.log(`[DEBUG] Raw Prompt: ${fullPrompt}`);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
        generationConfig: { temperature: CONFIG.TEMPERATURE }
      })
    });

    const data = await resp.json();
    console.log(`[DEBUG] Full API Response (${modelName}):`, JSON.stringify(data));

    // Handle Failover Cases
    if (resp.status === 429) return "FALLBACK_REQUIRED";
    if (resp.status === 400 && data.error?.status === "FAILED_PRECONDITION") {
       return "FALLBACK_REQUIRED";
    }

    if (data.candidates?.[0]?.finishReason === "SAFETY") {
      return "⚠️ The response was blocked by safety filters.";
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  },

  async addReaction(messageId, emojiType, token) {
    await fetch(`${CONFIG.BASE_URL_LARK}/im/v1/messages/${messageId}/reactions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reaction_type: { emoji_type: emojiType } })
    });
  },

  async sendLarkCard(messageId, text, token) {
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: text }]
    };
    await fetch(`${CONFIG.BASE_URL_LARK}/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "interactive", content: JSON.stringify(card) })
    });
  },

  async getLarkToken(appId, appSecret) {
    const resp = await fetch(`${CONFIG.BASE_URL_LARK}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const data = await resp.json();
    return data.tenant_access_token;
  }
};
