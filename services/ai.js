require('dotenv').config();

// Gemini API keys list (backup keys can be added to .env)
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(Boolean);

// OpenAI Configurations
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Helper to fetch with timeout using AbortController
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error(`İstek zaman aşımına uğradı (${timeoutMs}ms)`);
        }
        throw err;
    }
}

/**
 * Text Generation with Automatic Backup Keys & OpenAI Fallback
 */
async function generateText({ prompt, responseMimeType = 'text/plain', systemInstruction = '', model = 'gemini-2.5-flash', apiKey = null, baseUrl = null }) {
    // 0. Try Custom OpenAI Compatible endpoint first if provided or configured
    const effectiveKey = apiKey || process.env.CUSTOM_AI_KEY;
    const effectiveBase = baseUrl || process.env.CUSTOM_AI_BASE_URL;
    const effectiveModel = apiKey ? model : (process.env.CUSTOM_AI_MODEL || model);

    if (effectiveKey && effectiveBase && !effectiveBase.includes('googleapis.com')) {
        try {
            console.log(`[AI-SERVICE] Özel Yapay Zeka Servisi (${effectiveModel}) deneniyor...`);
            const url = effectiveBase.endsWith('/') ? effectiveBase + 'chat/completions' : effectiveBase + '/chat/completions';
            
            const messages = [];
            if (systemInstruction) {
                messages.push({ role: 'system', content: systemInstruction });
            }
            messages.push({ role: 'user', content: prompt });

            const body = {
                model: effectiveModel,
                messages: messages,
                temperature: 0.2
            };

            if (responseMimeType === 'application/json') {
                body.response_format = { type: 'json_object' };
            }

            const resp = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${effectiveKey}`
                },
                body: JSON.stringify(body)
            }, 50000);

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`Özel AI HTTP ${resp.status}: ${errText.slice(0, 150)}`);
            }

            const data = await resp.json();
            const text = data.choices?.[0]?.message?.content;
            if (!text) throw new Error("Özel AI yanıtı boş döndü");

            return text.trim();
        } catch (err) {
            console.error(`[AI-SERVICE] Özel AI hatası:`, err.message);
        }
    }

    // 1. Try Gemini API keys sequentially
    const keysToTry = (apiKey && !baseUrl && !GEMINI_KEYS.includes(apiKey)) ? [apiKey] : GEMINI_KEYS;
    for (let i = 0; i < keysToTry.length; i++) {
        const key = keysToTry[i];
        try {
            console.log(`[AI-SERVICE] Gemini anahtarı ${i + 1} deneniyor...`);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
            
            const body = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {}
            };
            
            if (responseMimeType === 'application/json') {
                body.generationConfig.responseMimeType = 'application/json';
            }
            
            if (systemInstruction) {
                body.systemInstruction = { parts: [{ text: systemInstruction }] };
            }

            const resp = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, 50000); // 50s timeout for Gemini text generation

            if (resp.status === 429) {
                console.warn(`[AI-SERVICE] Gemini anahtarı ${i + 1} kota sınırına ulaştı (429).`);
                continue;
            }

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 150)}`);
            }

            const data = await resp.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("Gemini yanıtı boş döndü");

            return text.trim();
        } catch (err) {
            console.error(`[AI-SERVICE] Gemini anahtarı ${i + 1} hatası:`, err.message);
        }
    }

    // 2. Fallback to OpenAI if Gemini fails or is not configured
    const openAiKeyToUse = (apiKey && !baseUrl) ? null : OPENAI_API_KEY;
    if (openAiKeyToUse) {
        try {
            console.log(`[AI-SERVICE] Tüm Gemini anahtarları başarısız veya bulunamadı. OpenAI (${OPENAI_MODEL}) deneniyor...`);
            const url = 'https://api.openai.com/v1/chat/completions';
            
            const messages = [];
            if (systemInstruction) {
                messages.push({ role: 'system', content: systemInstruction });
            }
            messages.push({ role: 'user', content: prompt });

            const body = {
                model: OPENAI_MODEL,
                messages: messages,
                temperature: 0.2
            };

            if (responseMimeType === 'application/json') {
                body.response_format = { type: 'json_object' };
            }

            const resp = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openAiKeyToUse}`
                },
                body: JSON.stringify(body)
            }, 50000); // 50s timeout for OpenAI text generation

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`OpenAI HTTP ${resp.status}: ${errText.slice(0, 150)}`);
            }

            const data = await resp.json();
            const text = data.choices?.[0]?.message?.content;
            if (!text) throw new Error("OpenAI yanıtı boş döndü");

            return text.trim();
        } catch (err) {
            console.error(`[AI-SERVICE] OpenAI hatası:`, err.message);
        }
    }

    throw new Error("Tüm AI servisleri (Gemini ve OpenAI) başarısız oldu veya yapılandırılmadı.");
}

/**
 * Multimodal Generation with Automatic Backup Keys & OpenAI Fallback (Images only)
 */
async function generateMultimodal({ parts, model = 'gemini-2.5-flash-lite' }) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        const key = GEMINI_KEYS[i];
        try {
            console.log(`[AI-SERVICE] Multimodal Gemini anahtarı ${i + 1} deneniyor...`);
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
            
            const resp = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
                }),
            }, 25000);

            if (resp.status === 429) {
                console.warn(`[AI-SERVICE] Multimodal Gemini anahtarı ${i + 1} kota sınırına ulaştı (429).`);
                continue;
            }

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 150)}`);
            }

            const data = await resp.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("Gemini multimodal yanıtı boş döndü");

            return text.trim();
        } catch (err) {
            console.error(`[AI-SERVICE] Multimodal Gemini anahtarı ${i + 1} hatası:`, err.message);
        }
    }

    // 2. Fallback to OpenAI (Vision / Multimodal)
    if (OPENAI_API_KEY) {
        try {
            console.log(`[AI-SERVICE] Multimodal Gemini anahtarları başarısız. OpenAI (gpt-4o-mini) deneniyor...`);
            const openaiContent = [];
            
            for (const part of parts) {
                if (part.text) {
                    openaiContent.push({ type: 'text', text: part.text });
                } else if (part.inline_data) {
                    const mime = part.inline_data.mime_type;
                    const base64 = part.inline_data.data;
                    
                    if (mime.startsWith('image/')) {
                        openaiContent.push({
                            type: 'image_url',
                            image_url: { url: `data:${mime};base64,${base64}` }
                        });
                    } else if (mime.startsWith('audio/')) {
                        console.warn("[AI-SERVICE] OpenAI base64 ses verisini chat completions içinde desteklemiyor, ses analizi OpenAI fallback'te atlandı.");
                    }
                }
            }

            if (openaiContent.length === 0) return null;

            const url = 'https://api.openai.com/v1/chat/completions';
            const resp = await fetchWithTimeout(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: openaiContent }],
                    temperature: 0.1,
                    max_tokens: 300,
                    response_format: { type: 'json_object' }
                })
            }, 25000);

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`OpenAI HTTP ${resp.status}: ${errText.slice(0, 150)}`);
            }

            const data = await resp.json();
            const text = data.choices?.[0]?.message?.content;
            if (!text) throw new Error("OpenAI multimodal yanıtı boş döndü");

            return text.trim();
        } catch (err) {
            console.error(`[AI-SERVICE] Multimodal OpenAI hatası:`, err.message);
        }
    }

    throw new Error("Tüm Multimodal AI servisleri başarısız oldu.");
}

module.exports = {
    generateText,
    generateMultimodal,
    hasAiService: GEMINI_KEYS.length > 0 || !!OPENAI_API_KEY
};
