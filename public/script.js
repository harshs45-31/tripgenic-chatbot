
// ---------- Elements ----------
const scrollArea = document.getElementById("scroll-area");
const welcome = document.getElementById("welcome");
const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const newChatBtn = document.getElementById("new-chat");
const themeBtn = document.getElementById("theme-toggle");
const planForm = document.getElementById("plan-form");

// Chat history (server ko har baar bhejte hain, taaki chatbot pichli baat yaad rakhe)
let history = [];
let busy = false;

const BOT_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/></svg>';

const FOLLOW_UPS = [
  "Make it cheaper",
  "Add hotel options",
  "Best time to visit?",
  "What should I pack?",
];

// ---------- Theme (light / dark) ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("tripgenic-theme", theme); } catch (e) {}
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("tripgenic-theme"); } catch (e) {}
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
})();

themeBtn.addEventListener("click", () => {
  const now = document.documentElement.getAttribute("data-theme");
  applyTheme(now === "dark" ? "light" : "dark");
});

// ---------- Markdown ----------
if (window.DOMPurify) {
  // Links hamesha nayi tab mein khulein
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

function renderMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
  }
  // Agar CDN load na ho toh plain text dikhao
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}

function wrapTables(container) {
  container.querySelectorAll("table").forEach((table) => {
    if (table.parentElement.classList.contains("table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

// ---------- UI helpers ----------
function scrollToBottom() {
  scrollArea.scrollTop = scrollArea.scrollHeight;
}

function hideWelcome() {
  welcome.style.display = "none";
}

function showWelcome() {
  welcome.style.display = "block";
}

function addUserMessage(text) {
  const row = document.createElement("div");
  row.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "bubble-user";
  bubble.textContent = text;
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
}

function addBotMessage() {
  const row = document.createElement("div");
  row.className = "msg bot";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.innerHTML = BOT_ICON;

  const col = document.createElement("div");
  col.className = "bot-col";

  const bubble = document.createElement("div");
  bubble.className = "bubble-bot";

  const body = document.createElement("div");
  body.className = "md";
  bubble.appendChild(body);

  const tools = document.createElement("div");
  tools.className = "bot-tools";

  col.appendChild(bubble);
  col.appendChild(tools);
  row.appendChild(avatar);
  row.appendChild(col);
  messagesEl.appendChild(row);

  return {
    showTyping() {
      body.innerHTML = '<div class="dots" aria-label="Tripgenic is thinking"><span></span><span></span><span></span></div>';
    },
    render(text, streaming) {
      body.innerHTML = renderMarkdown(text);
      wrapTables(body);
      body.classList.toggle("streaming", Boolean(streaming));
    },
    showError(message) {
      bubble.classList.add("error");
      body.classList.remove("streaming");
      body.textContent = message;
    },
    addTools(rawText) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "chip";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(rawText);
          copy.textContent = "Copied!";
        } catch (e) {
          copy.textContent = "Copy failed";
        }
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
      tools.appendChild(copy);

      FOLLOW_UPS.forEach((label) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = label;
        chip.addEventListener("click", () => sendMessage(label));
        tools.appendChild(chip);
      });
    },
  };
}

function clearOldTools() {
  messagesEl.querySelectorAll(".bot-tools").forEach((el) => (el.innerHTML = ""));
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  input.disabled = value;
  if (!value) input.focus();
}

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

// ---------- Sending a message ----------
async function sendMessage(text) {
  text = (text || "").trim();
  if (!text || busy) return;

  hideWelcome();
  clearOldTools();
  addUserMessage(text);
  history.push({ role: "user", text });

  input.value = "";
  autoResize();
  setBusy(true);

  const bot = addBotMessage();
  bot.showTyping();
  scrollToBottom();

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    if (!res.ok) {
      let message = "Something went wrong. Please try again.";
      try {
        const data = await res.json();
        if (data.error) message = data.error;
      } catch (e) {}
      throw new Error(message);
    }

    // Jawab tukdon mein aata hai, aur hum live dikhate hain
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      bot.render(full, true);
      scrollToBottom();
    }
    full += decoder.decode();

    if (!full.trim()) throw new Error("No answer was returned. Please try again.");

    bot.render(full, false);
    history.push({ role: "model", text: full });
    bot.addTools(full);
  } catch (err) {
    // Fail hue sawal ko history se hata do, taaki agli baar chat sahi rahe
    history.pop();
    bot.showError(err.message || "Could not reach the server.");
  } finally {
    setBusy(false);
    scrollToBottom();
  }
}

// ---------- Events ----------
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(input.value);
});

input.addEventListener("keydown", (e) => {
  // Enter = send, Shift + Enter = nayi line
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(input.value);
  }
});

input.addEventListener("input", autoResize);

document.querySelectorAll(".suggestion").forEach((btn) => {
  btn.addEventListener("click", () => sendMessage(btn.dataset.prompt));
});

planForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const dest = document.getElementById("pf-dest").value.trim();
  const from = document.getElementById("pf-from").value.trim();
  const days = document.getElementById("pf-days").value;
  const people = document.getElementById("pf-people").value;
  const budget = document.getElementById("pf-budget").value.trim();
  const style = document.getElementById("pf-style").value;

  let prompt = `Plan a ${days}-day trip to ${dest}`;
  if (from) prompt += ` starting from ${from}`;
  prompt += ` for ${people} traveller${people === "1" ? "" : "s"}.`;
  if (budget) prompt += ` Total budget: Rs ${budget}.`;
  prompt += ` Travel style: ${style}.`;
  prompt += " Include a day-wise itinerary, stay options, food to try, local transport and a budget table.";

  sendMessage(prompt);
});

newChatBtn.addEventListener("click", () => {
  if (busy) return;
  history = [];
  messagesEl.innerHTML = "";
  showWelcome();
  scrollArea.scrollTop = 0;
});
