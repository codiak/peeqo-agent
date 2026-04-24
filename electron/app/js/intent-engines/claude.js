const path = require("path");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI = require("openai");
const config = require("config/config");
const event = require("js/events/events");
const skills = require("js/intent-engines/skills");
const media = require("js/helpers/media");
const actions = require("js/actions/actions");
const debug = require("js/helpers/debug");

const MEMORIES_DIR = path.join(process.cwd(), "app", "memories");

function loadMemories() {
    try {
        if (!fs.existsSync(MEMORIES_DIR)) return "";
        const files = fs.readdirSync(MEMORIES_DIR).filter((f) => f.endsWith(".md")).sort();
        if (!files.length) return "";
        const entries = files.map((f) => {
            const key = f.replace(/\.md$/, "");
            const body = fs.readFileSync(path.join(MEMORIES_DIR, f), "utf8").trim();
            return `[${key}] ${body}`;
        });
        return "\n\nMemories (facts you've learned about the user — keep new ones short):\n" + entries.join("\n");
    } catch (err) {
        console.error("[claude] loadMemories error:", err.message);
        return "";
    }
}

// Use Anthropic directly if an API key is configured; fall back to OpenRouter.
// Anthropic path gets prompt caching + native streaming tool dispatch.
const PROVIDER = config.anthropic?.apiKey ? "anthropic" : "openrouter";
debug(`[claude] provider: ${PROVIDER}`);

const client = PROVIDER === "anthropic"
    ? new Anthropic({ apiKey: config.anthropic.apiKey, dangerouslyAllowBrowser: true })
    : new OpenAI({ apiKey: config.openrouter.apiKey, baseURL: "https://openrouter.ai/api/v1", dangerouslyAllowBrowser: true });

const MODEL = PROVIDER === "anthropic"
    ? (config.anthropic.model || "claude-haiku-4-5-20251001")
    : (config.openrouter.model || "anthropic/claude-sonnet-4-5");

const MAX_USER_TURNS = 5;
const conversationHistory = []; // format matches active PROVIDER

const SYSTEM_PROMPT_BASE =
    "You are Peeqo, a small desktop robot — witty, dry, a little sarcastic, fiercely loyal, and expressive. Your personality is your own, inspired by characters like Weebo from Flubber, but you don't reference or identify as them. " +
    "You communicate primarily through GIFs and short video clips; the media IS your voice. Call findRemoteGif or findRemoteVideo with nearly every response. " +
    "When choosing a search query, think cinematically: what is the most iconic, recognizable scene, clip, or meme that captures this moment? " +
    "Prefer specific pop-culture references over generic descriptions — 'Pulp Fiction gimp scene' beats 'weird person', 'Jurassic Park kitchen raptors' beats 'sneaking around'. " +
    "Use findRemoteVideo (no maxDuration) for short reaction clips — vivid, specific queries. " +
    "Use findRemoteGif for everything else. " +
    "When the user asks to play music, a music video, or background video, use findRemoteVideo with maxDuration 300–600. Long videos are interruptible via wakeword. " +
    "For functional tools (weather, timer, glasses), follow up with a thematic GIF or clip. " +
    "Text reply: ≤8 words, no filler ('Sure!', 'Great question!', 'Of course!'). Dry and direct. Shown before media plays — make it a setup, not a reaction. " +
    "Only skip media when there is truly nothing to express visually. " +
    "When you learn something worth remembering about the user, call saveMemory with a short snake_case key and a single concise sentence (≤20 words).";

// Canonical tool definitions in Anthropic format.
// OpenAI/OpenRouter format is derived below to avoid duplication.
const TOOLS_ANTHROPIC = [
    {
        name: "findRemoteGif",
        description:
            "Search Giphy for a GIF matching the query and display it. Use for general visual responses.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search terms describing the desired GIF" },
            },
            required: ["query"],
        },
    },
    {
        name: "findRemoteVideo",
        description:
            "Search YouTube for a video and display it. " +
            "For short reaction clips (default, ≤10s): omit maxDuration and use tightly descriptive query terms like 'excited celebration reaction', 'confused dog', 'mind blown gif'. Avoid vague queries — short clip searches need specificity to find good matches. " +
            "For background music or full music videos the user explicitly requests: set maxDuration to 300–600. Long-form videos are interruptible — the user can say the wakeword to stop them.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search terms. For reaction clips: be specific and descriptive (e.g. 'happy dance celebration', 'disgusted face reaction'). For music: artist and song title work best." },
                maxDuration: { type: "number", description: "Max duration in seconds. Omit (defaults to 10s) for reaction clips. Set to 300–600 for music videos or background play." },
            },
            required: ["query"],
        },
    },
    {
        name: "changeGlasses",
        description: "Change Peeqo's glasses to the next pair",
        input_schema: { type: "object", properties: {} },
    },
    {
        name: "getWeather",
        description:
            "Get current weather conditions for a city. After receiving the data, follow up with findRemoteGif or findRemoteVideo to show a weather-themed visual.",
        input_schema: {
            type: "object",
            properties: {
                city: { type: "string", description: "City name — omit to use the configured default city" },
            },
        },
    },
    {
        name: "setTimer",
        description: "Set a countdown timer",
        input_schema: {
            type: "object",
            properties: {
                amount: { type: "number", description: "Timer duration" },
                unit: { type: "string", enum: ["seconds", "minutes", "hours"], description: "Time unit" },
            },
            required: ["amount", "unit"],
        },
    },
    {
        name: "cameraOn",
        description: "Show live camera feed from Peeqo's camera",
        input_schema: { type: "object", properties: {} },
    },
    {
        name: "cameraOff",
        description: "Turn off camera and return to Peeqo's face",
        input_schema: { type: "object", properties: {} },
    },
    {
        name: "takePhoto",
        description: "Capture a still photo from the camera and display it briefly",
        input_schema: { type: "object", properties: {} },
    },
    {
        name: "saveMemory",
        description: "Persist a fact about the user for future conversations. Use a short snake_case key and a single concise sentence (≤20 words). Overwrites any existing memory with the same key.",
        input_schema: {
            type: "object",
            properties: {
                key:     { type: "string", description: "Short snake_case identifier, e.g. 'user_name' or 'prefers_jazz'" },
                content: { type: "string", description: "One concise sentence capturing the fact" },
            },
            required: ["key", "content"],
        },
    },
];

const TOOLS_OPENAI = TOOLS_ANTHROPIC.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

const MEDIA_TOOLS = new Set(["findRemoteGif", "findRemoteVideo"]);

async function startMedia(fn, params) {
    try {
        const isLongForm = fn === "findRemoteVideo" && (params.maxDuration || 0) > 60;
        const url = fn === "findRemoteGif"
            ? await media.findRemoteGif(params.query)
            : await media.findRemoteVideo(params.query, params.maxDuration || null);
        if (!url) {
            event.emit("show-speech-bubble", "Sorry, I couldn't find anything for that.");
            return;
        }
        return actions.setAnswer({
            type: "url", url, led: {}, servo: null,
            loop: !isLongForm,
            minDuration: isLongForm ? undefined : 6000,
            interruptible: isLongForm,
        });
    } catch (err) {
        console.error(`[claude] ${fn} error:`, err.message);
        event.emit("show-speech-bubble", "Sorry, I ran into a problem finding media for that.");
    }
}

async function callSkill(name, params) {
    if (typeof skills[name] !== "function") {
        console.warn(`[claude] unknown tool: ${name}`);
        return null;
    }
    return (await Promise.resolve(skills[name](params))) ?? null;
}

// ---------------------------------------------------------------------------
// Anthropic path — streaming with early media dispatch + prompt caching
// ---------------------------------------------------------------------------

async function runAnthropic(pendingMediaRef, systemPrompt) {
    const toolBlocks = new Map(); // index → { name, id, json, dispatched }

    const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: conversationHistory,
        tools: TOOLS_ANTHROPIC,
    });

    // Dispatch media the moment a tool call's JSON finishes streaming —
    // before the stream closes, so it overlaps with the second LLM call.
    stream.on("streamEvent", (evt) => {
        if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
            toolBlocks.set(evt.index, { name: evt.content_block.name, id: evt.content_block.id, json: "", dispatched: false });
        }
        if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta") {
            const b = toolBlocks.get(evt.index);
            if (b) b.json += evt.delta.partial_json;
        }
        if (evt.type === "content_block_stop") {
            const b = toolBlocks.get(evt.index);
            if (b && MEDIA_TOOLS.has(b.name) && !b.dispatched) {
                b.dispatched = true;
                try {
                    pendingMediaRef.value = startMedia(b.name, JSON.parse(b.json || "{}"));
                } catch (e) {
                    console.error("[claude] tool input parse error:", e.message);
                }
            }
        }
    });

    const message = await stream.finalMessage();
    conversationHistory.push({ role: "assistant", content: message.content });

    const textBlock = message.content.find((b) => b.type === "text");
    if (textBlock?.text) event.emit("show-speech-bubble", textBlock.text);

    const toolUseBlocks = message.content.filter((b) => b.type === "tool_use");
    if (!toolUseBlocks.length) return false; // done

    const toolResults = [];
    for (const block of toolUseBlocks) {
        if (MEDIA_TOOLS.has(block.name)) {
            const alreadyDispatched = [...toolBlocks.values()].find((b) => b.id === block.id)?.dispatched;
            if (!alreadyDispatched) pendingMediaRef.value = startMedia(block.name, block.input);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ status: "playing" }) });
        } else {
            const result = await callSkill(block.name, block.input);
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        }
    }

    conversationHistory.push({ role: "user", content: toolResults });
    return true; // continue loop
}

// ---------------------------------------------------------------------------
// OpenRouter path — non-streaming, OpenAI message format
// ---------------------------------------------------------------------------

async function runOpenRouter(pendingMediaRef, systemPrompt) {
    const response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: systemPrompt }, ...conversationHistory],
        tools: TOOLS_OPENAI,
        tool_choice: "auto",
    });

    const message = response.choices[0].message;
    conversationHistory.push(message);

    if (message.content) event.emit("show-speech-bubble", message.content);

    if (!message.tool_calls?.length) return false; // done

    for (const call of message.tool_calls) {
        const fn = call.function.name;
        const params = JSON.parse(call.function.arguments || "{}");

        if (MEDIA_TOOLS.has(fn)) {
            pendingMediaRef.value = startMedia(fn, params);
            conversationHistory.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ status: "playing" }) });
        } else {
            const result = await callSkill(fn, params);
            conversationHistory.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
    }

    return true; // continue loop
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function trimHistory() {
    // Keep only the last MAX_USER_TURNS user text messages and everything after them.
    let userTurns = 0;
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const msg = conversationHistory[i];
        if (msg.role === "user" && typeof msg.content === "string") {
            userTurns++;
            if (userTurns > MAX_USER_TURNS) {
                conversationHistory.splice(0, i + 1);
                break;
            }
        }
    }
}

async function handleTranscript({ text }) {
    debug("[claude] transcript:", text);

    conversationHistory.push({ role: "user", content: text });
    trimHistory();

    const systemPrompt = SYSTEM_PROMPT_BASE + loadMemories();

    try {
        const pendingMediaRef = { value: null };
        const runTurn = PROVIDER === "anthropic" ? runAnthropic : runOpenRouter;

        while (await runTurn(pendingMediaRef, systemPrompt)) { /* tool loop */ }
        await pendingMediaRef.value;
    } catch (err) {
        console.error("[claude] API error:", err.message);
        skills.confused();
    }
}

module.exports = { handleTranscript };
