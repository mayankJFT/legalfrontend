// ===== Global Variables & State =====
const API_BASE_URL = 'http://localhost:8000'; // Adjust if backend runs elsewhere
let selectedModel = '';
let selectedStrategy = 'simple';
let temperatureValue = 0.2;
let maxTokens = 2048;
let streamingEnabled = true;

let currentConversationId = null;
let conversationHistory = [];
let isLoading = false;
let abortController = null;

// Will hold references to the message element being deleted
let messageToDelete = null;
let messageIndexToDelete = null;

// ===== DOM References =====
const elements = {
  // Onboarding
  onboardingLoader: document.getElementById('onboarding-loader'),

  // Header
  menuToggle: document.getElementById('menu-toggle'),
  themeToggle: document.getElementById('theme-toggle'),
  settingsBtn: document.getElementById('settings-btn'),

  // Sidebar
  sidebar: document.getElementById('sidebar'),
  newSessionBtn: document.getElementById('new-session-btn'),
  historyList: document.getElementById('history-list'),
  clearCacheBtn: document.getElementById('clear-cache-btn'),

  // Chat
  messagesContainer: document.getElementById('messages'),
  queryInput: document.getElementById('query-input'),
  sendBtn: document.getElementById('send-btn'),
  charCount: document.getElementById('char-count'),
  modelInfo: document.getElementById('model-info'),

  // Settings Modal
  settingsModal: document.getElementById('settings-modal'),
  settingsClose: document.getElementById('settings-close'),
  settingsCancel: document.getElementById('settings-cancel'),
  settingsSave: document.getElementById('settings-save'),
  defaultModel: document.getElementById('default-model'),
  defaultStrategy: document.getElementById('default-strategy'),
  defaultTempSlider: document.getElementById('default-temp-slider'),
  defaultTemperature: document.getElementById('default-temperature'),
  maxTokensInput: document.getElementById('max-tokens'),
  streamingCheckbox: document.getElementById('streaming-enabled'),

  // Delete Modal
  deleteModal: document.getElementById('delete-modal'),
  deleteClose: document.getElementById('delete-close'),
  deleteCancel: document.getElementById('delete-cancel'),
  deleteConfirm: document.getElementById('delete-confirm'),

  // SESSION NAME MODAL
  sessionNameModal: document.getElementById('session-name-modal'),
  sessionNameInput: document.getElementById('session-name-input'),
  sessionNameSave: document.getElementById('session-name-save'),

  // Others
  toastContainer: document.getElementById('toast-container'),
  loadingOverlay: document.getElementById('loading-overlay'),
};

// ===== Initialization =====
async function init() {
  try {
    // Show loader
    elements.onboardingLoader.style.display = 'flex';

    // Load saved settings (theme, etc.)
    loadSettings();

    // Fetch available models from backend
    await fetchModels();

    // Render existing conversation history (if any)
    renderHistorySidebar();

    // Set up event listeners
    setupEventListeners();

    // Check for existing conversation cookie
    currentConversationId = getCookie('conversation_id');
    if (!currentConversationId) {
      // No existing session → show the “Name Your Chat” modal immediately
      elements.sessionNameModal.style.display = 'flex';
    } else {
      // We have a conversation ID in cookie → load it
      const activeItem = elements.historyList.querySelector(
        `[data-conv-id="${currentConversationId}"]`
      );
      if (activeItem) activeItem.classList.add('active');

      await loadConversation(currentConversationId);
      updateModelInfo();
      autoResizeTextarea();
    }

    // Fade out loader after a brief delay
    setTimeout(() => {
      elements.onboardingLoader.classList.add('fade-out');
      setTimeout(() => {
        elements.onboardingLoader.style.display = 'none';
      }, 500);
    }, 1000);

  } catch (error) {
    console.error('Initialization error:', error);
    showToast('Failed to initialize application', 'error');
    elements.onboardingLoader.style.display = 'none';
  }
}

// ===== API Functions =====
async function fetchModels() {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    const data = await response.json();

    if (data.available_models) {
      const modelOptions = data.available_models
        .map((model) => `<option value="${model}">${model}</option>`)
        .join('');
      elements.defaultModel.innerHTML = modelOptions;
      selectedModel = data.available_models[0];
      elements.defaultModel.value = selectedModel;
    }
  } catch (error) {
    console.error('Error fetching models:', error);
    // Fallback to defaults if backend is unreachable
    const defaultModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
    const modelOptions = defaultModels
      .map((model) => `<option value="${model}">${model}</option>`)
      .join('');
    elements.defaultModel.innerHTML = modelOptions;
    selectedModel = defaultModels[0];
    elements.defaultModel.value = selectedModel;
  }
}

// ===== Session Initialization (First-Time) =====
async function initializeSession(sessionName) {
  // Create a new unique ID
  const newId = Date.now().toString();
  currentConversationId = newId;
  setCookie('conversation_id', newId, 30);

  // Save into localStorage history with the given name
  saveConversationToHistory(newId, sessionName);
  renderHistorySidebar();

  // Clear chat area (show welcome)
  elements.messagesContainer.innerHTML = `
    <div class="welcome-message">
      <h2>Welcome to NyayaGPT</h2>
      <p>Your futuristic legal AI assistant.</p>
      <p>Ask me anything about cases, statutes, or precedents!</p>
    </div>
  `;
  updateModelInfo();
  autoResizeTextarea();

  // Hide the “Name Your Chat” modal
  elements.sessionNameModal.style.display = 'none';
}

// ===== Sending a Query =====
async function sendQuery(query) {
  if (isLoading) return;
  isLoading = true;
  elements.sendBtn.disabled = true;

  // Create & append the User bubble
  const userMessage = createUserBubble(query);
  elements.messagesContainer.appendChild(userMessage);

  // Remove any “welcome” text
  const welcomeMessage = elements.messagesContainer.querySelector('.welcome-message');
  if (welcomeMessage) welcomeMessage.remove();

  // Create AI bubble with chain-of-thought loader
  const aiMessage = createAIBubble();
  const chainLoader = createChainLoader();
  aiMessage.querySelector('.msg-bubble').appendChild(chainLoader);
  elements.messagesContainer.appendChild(aiMessage);

  // Always scroll to bottom
  scrollToBottom();

  // Prepare to abort if needed
  abortController = new AbortController();

  try {
    // Build request payload
    const requestBody = {
      query: query,
      model_name: selectedModel,
      strategy: selectedStrategy,
      temperature: temperatureValue,
      max_tokens: maxTokens,
      stream: streamingEnabled,
      conversation_id: currentConversationId,
      include_history: true,
    };

    if (streamingEnabled) {
      await handleStreamingResponse(requestBody, aiMessage, chainLoader);
    } else {
      await handleRegularResponse(requestBody, aiMessage, chainLoader);
    }
  } catch (error) {
    console.error('Error sending query:', error);
    chainLoader.remove();
    const errorContent = aiMessage.querySelector('.msg-bubble .msg-content');
    errorContent.textContent = 'Oops, something went wrong. Try again.';
    showToast('Failed to send query', 'error');
    scrollToBottom();
  } finally {
    isLoading = false;
    elements.sendBtn.disabled = false;
    elements.queryInput.focus();
  }
}

async function handleStreamingResponse(requestBody, aiMessage, chainLoader) {
  const response = await fetch(`${API_BASE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: abortController.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const messageContent = aiMessage.querySelector('.msg-bubble .msg-content');
  let fullResponse = '';
  let metadata = null;
  let sources = [];

  // Remove the chain-loader on first chunk
  chainLoader.remove();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));

          if (data.chunk) {
            fullResponse += data.chunk;
            messageContent.innerHTML = formatResponse(fullResponse);
            scrollToBottom();
          }

          if (data.done) {
            metadata = data.metadata;
            sources = data.context_sources || [];
            if (metadata && metadata.conversation_id) {
              currentConversationId = metadata.conversation_id;
              setCookie('conversation_id', currentConversationId, 30);
              // Save new session name if provided
              if (metadata.session_name) {
                saveConversationToHistory(currentConversationId, metadata.session_name);
                renderHistorySidebar();
              }
            }
          }

          if (data.error) {
            messageContent.textContent = data.full || 'An error occurred.';
            showToast('Error: ' + data.error, 'error');
            scrollToBottom();
          }
        } catch (e) {
          console.error('Error parsing stream data:', e);
        }
      }
    }
  }

  // After streaming completes, scroll one more time
  scrollToBottom();

  // Add citations if available
  if (sources.length) {
    addCitationsToMessage(aiMessage, sources);
    scrollToBottom();
  }

  // Add metadata attributes for debugging if needed
  if (metadata) {
    addMetadataToMessage(aiMessage, metadata);
  }

  // Attach delete button
  addDeleteButton(aiMessage);
  scrollToBottom();
}

async function handleRegularResponse(requestBody, aiMessage, chainLoader) {
  const response = await fetch(`${API_BASE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: abortController.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  chainLoader.remove();

  const messageContent = aiMessage.querySelector('.msg-bubble .msg-content');
  messageContent.innerHTML = formatResponse(data.response);
  scrollToBottom();

  if (data.metadata && data.metadata.conversation_id) {
    currentConversationId = data.metadata.conversation_id;
    setCookie('conversation_id', currentConversationId, 30);
    if (data.metadata.session_name) {
      saveConversationToHistory(currentConversationId, data.metadata.session_name);
      renderHistorySidebar();
    }
  }

  if (Array.isArray(data.context_sources) && data.context_sources.length) {
    addCitationsToMessage(aiMessage, data.context_sources);
    scrollToBottom();
  }

  if (data.metadata) {
    addMetadataToMessage(aiMessage, data.metadata);
  }

  addDeleteButton(aiMessage);
  scrollToBottom();
}

// ===== Conversation Loading & Deletion =====
async function loadConversation(conversationId) {
  try {
    const response = await fetch(`${API_BASE_URL}/conversation/${conversationId}`);
    if (!response.ok) {
      if (response.status === 404) {
        currentConversationId = null;
        return;
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    conversationHistory = data.messages || [];

    // Clear the chat area
    elements.messagesContainer.innerHTML = '';

    // Render each message in order
    conversationHistory.forEach((message, idx) => {
      if (message.role === 'user') {
        const userBubble = createUserBubble(message.content);
        userBubble.dataset.messageIndex = idx;
        elements.messagesContainer.appendChild(userBubble);
      } else if (message.role === 'assistant') {
        const aiBubble = createAIBubble(formatResponse(message.content));
        aiBubble.dataset.messageIndex = idx;
        addDeleteButton(aiBubble);
        elements.messagesContainer.appendChild(aiBubble);
      }
    });

    scrollToBottom();
  } catch (error) {
    console.error('Error loading conversation:', error);
    showToast('Failed to load conversation', 'error');
  }
}

async function deleteMessage(messageElement, messageIndex) {
  if (!currentConversationId || messageIndex === undefined) return;

  try {
    const response = await fetch(
      `${API_BASE_URL}/conversation/${currentConversationId}/message/${messageIndex}`,
      {
        method: 'DELETE',
      }
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Animate removal
    messageElement.style.opacity = '0';
    messageElement.style.transform = 'translateX(20px)';
    setTimeout(() => {
      messageElement.remove();
    }, 300);

    showToast('Message deleted', 'success');

    // Reload conversation to reindex messages
    setTimeout(() => {
      loadConversation(currentConversationId);
    }, 400);
  } catch (error) {
    console.error('Error deleting message:', error);
    showToast('Failed to delete message', 'error');
  }
}

async function clearConversationHistory() {
  try {
    if (currentConversationId) {
      await fetch(`${API_BASE_URL}/conversation/${currentConversationId}`, {
        method: 'DELETE',
      });
    }

    // Reset local state
    currentConversationId = null;
    conversationHistory = [];
    elements.messagesContainer.innerHTML = `
      <div class="welcome-message">
        <h2>Welcome to NyayaGPT</h2>
        <p>Your futuristic legal AI assistant.</p>
        <p>Ask me anything about cases, statutes, or precedents!</p>
      </div>
    `;
    setCookie('conversation_id', '', -1);
    showToast('Started a new conversation', 'success');
  } catch (error) {
    console.error('Error clearing history:', error);
    showToast('Failed to clear history', 'error');
  }
}

async function clearCache() {
  try {
    elements.loadingOverlay.style.display = 'flex';
    const response = await fetch(`${API_BASE_URL}/clear-cache`);
    const data = await response.json();
    if (data.status === 'success') {
      showToast(data.message, 'success');
    } else {
      showToast('Failed to clear cache', 'error');
    }
  } catch (error) {
    console.error('Error clearing cache:', error);
    showToast('Failed to clear cache', 'error');
  } finally {
    elements.loadingOverlay.style.display = 'none';
  }
}

// ===== Event Listeners Setup (including session-name modal) =====
function setupEventListeners() {
  // Header buttons
  elements.menuToggle.addEventListener('click', toggleSidebar);
  elements.themeToggle.addEventListener('click', toggleTheme);
  elements.settingsBtn.addEventListener('click', openSettings);

  // Sidebar
  elements.newSessionBtn.addEventListener('click', () => {
    elements.sessionNameInput.value = '';
    elements.sessionNameModal.style.display = 'flex';
  });
  elements.clearCacheBtn.addEventListener('click', clearCache);

  // Session-Name Modal: when user clicks “Start Chat”
  elements.sessionNameSave.addEventListener('click', () => {
    const name = elements.sessionNameInput.value.trim();
    if (!name) {
      showToast('Please enter a conversation name.', 'warning');
      return;
    }
    initializeSession(name);
  });

  // Query input
  elements.queryInput.addEventListener('input', () => {
    autoResizeTextarea();
    updateCharCount();
  });
  elements.queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  elements.sendBtn.addEventListener('click', handleSend);

  // Settings modal
  elements.settingsClose.addEventListener('click', closeSettings);
  elements.settingsCancel.addEventListener('click', closeSettings);
  elements.settingsSave.addEventListener('click', saveSettingsAndClose);
  elements.defaultTempSlider.addEventListener('input', (e) => {
    elements.defaultTemperature.value = e.target.value;
  });
  elements.defaultTemperature.addEventListener('change', (e) => {
    elements.defaultTempSlider.value = e.target.value;
  });

  // Delete modal
  elements.deleteClose.addEventListener('click', closeDeleteModal);
  elements.deleteCancel.addEventListener('click', closeDeleteModal);
  elements.deleteConfirm.addEventListener('click', confirmDelete);

  // Close modals on outside click
  elements.settingsModal.addEventListener('click', (e) => {
    if (e.target === elements.settingsModal) {
      closeSettings();
    }
  });
  elements.deleteModal.addEventListener('click', (e) => {
    if (e.target === elements.deleteModal) {
      closeDeleteModal();
    }
  });
  // Do not close session-name modal on outside click—user must name it

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Esc to close Settings/Delete modals (but not session-name modal)
    if (e.key === 'Escape') {
      if (elements.settingsModal.style.display !== 'none') {
        closeSettings();
      }
      if (elements.deleteModal.style.display !== 'none') {
        closeDeleteModal();
      }
      // Do NOT close session-name modal with Escape
    }
    // Ctrl/Cmd + K to focus input
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      elements.queryInput.focus();
    }
  });

  // Collapse sidebar on mobile
  window.addEventListener('resize', () => {
    if (isMobile() && !elements.sidebar.classList.contains('collapsed')) {
      elements.sidebar.classList.add('collapsed');
    }
  });
}

// ===== Helper Functions =====

/**
 * formatResponse(text)
 *
 * - Strips out any Markdown heading markers (#, ##, ###, etc.) entirely.
 * - Converts bold, italics, lists, code blocks, inline code, and line breaks.
 */
function formatResponse(text) {
  let formatted = text;

  // 1) STRIP OUT ANY LEVEL OF MARKDOWN HEADER (####, ###, ##, #, etc.)
  formatted = formatted.replace(/^#{1,6}\s*(.*?)$/gm, '$1');

  // 2) (Optional) If you still want <h1> and <h2> for small headings,
  //    you could re-insert them here. In this example, we keep all as plain text.
  //    For example:
  // formatted = formatted.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
  // formatted = formatted.replace(/^## (.*?)$/gm, '<h2>$1</h2>');

  // 3) BOLD
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // 4) ITALICS
  formatted = formatted.replace(
    /(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g,
    '<em>$1</em>'
  );

  // 5) UNORDERED LIST
  formatted = formatted.replace(/^- (.*?)$/gm, '<li>$1</li>');
  formatted = formatted.replace(
    /(<li>.*?<\/li>\s*)+/gs,
    (match) => '<ul>' + match + '</ul>'
  );

  // 6) ORDERED LIST
  formatted = formatted.replace(/^\d+\. (.*?)$/gm, '<li>$1</li>');

  // 7) CODE BLOCKS
  formatted = formatted.replace(
    /```(.*?)```/gs,
    '<pre><code>$1</code></pre>'
  );

  // 8) INLINE CODE
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 9) LINE BREAKS
  formatted = formatted.replace(/\n\n/g, '</p><p>');
  formatted = formatted.replace(/\n/g, '<br>');

  // 10) WRAP paragraphs if none present
  if (!formatted.startsWith('<')) {
    formatted = '<p>' + formatted + '</p>';
  }

  return formatted;
}

// Create a User message bubble + avatar on the right
function createUserBubble(text) {
  const message = document.createElement('div');
  message.className = 'message user-message';

  message.innerHTML = `
    <div class="msg-bubble">
      <div class="msg-content">${escapeHtml(text)}</div>
    </div>
    <div class="msg-avatar">
      <img
        src="https://cdn-icons-png.flaticon.com/512/149/149071.png"
        alt="User Avatar"
      />
    </div>
  `;

  return message;
}

// Create an AI message bubble + avatar on the left
function createAIBubble(html = '') {
  const message = document.createElement('div');
  message.className = 'message ai-message';

  message.innerHTML = `
    <div class="msg-avatar">
      <img
        src="https://cdn-icons-png.flaticon.com/512/4712/4712027.png"
        alt="Bot Avatar"
      />
    </div>
    <div class="msg-bubble">
      <div class="msg-content">${html}</div>
      <div class="msg-actions"></div>
    </div>
  `;

  return message;
}

// Chain-of-Thought Loader: “🔍 Evaluating…”
function createChainLoader() {
  const loader = document.createElement('div');
  loader.className = 'chain-loader';
  loader.innerHTML = `
    <span>🔍 Evaluating…”</span>
    <span class="dot dot1">.</span>
    <span class="dot dot2">.</span>
    <span class="dot dot3">.</span>
  `;
  return loader;
}

// Attach a delete button to an AI bubble (hidden by default in CSS)
function addDeleteButton(aiMessage) {
  const bubble = aiMessage.querySelector('.msg-bubble');
  const actionsDiv = bubble.querySelector('.msg-actions');
  actionsDiv.innerHTML = `
    <button class="delete-btn" aria-label="Delete message">
      <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none">
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14M10 11v6M14 11v6" />
      </svg>
    </button>
  `;
  const deleteBtn = actionsDiv.querySelector('.delete-btn');
  deleteBtn.addEventListener('click', () => {
    openDeleteModal(aiMessage);
  });
}

// Citations toggle (source list)
function addCitationsToMessage(message, sources) {
  const bubble = message.querySelector('.msg-bubble');
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'citations-toggle';
  toggleBtn.textContent = `View Sources (${sources.length})`;
  toggleBtn.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'citations-panel';

  const citationsHtml = sources
    .map(
      (source, idx) => `
      <div class="citation-item">
        <a href="${source.url || '#'}" target="_blank" rel="noopener" class="citation-title">
          ${escapeHtml(source.title || `Source ${idx + 1}`)}
        </a>
        <div class="citation-snippet">${escapeHtml(source.snippet || '')}</div>
        ${source.page ? `<div class="citation-page">Page ${source.page}</div>` : ''}
      </div>
    `
    )
    .join('');
  panel.innerHTML = citationsHtml;

  toggleBtn.addEventListener('click', () => {
    const isExpanded = panel.classList.contains('expanded');
    panel.classList.toggle('expanded');
    toggleBtn.setAttribute('aria-expanded', !isExpanded);
    toggleBtn.textContent = isExpanded ? `View Sources (${sources.length})` : `Hide Sources`;
  });

  bubble.appendChild(toggleBtn);
  bubble.appendChild(panel);
}

// Attach metadata as data-attributes (optional)
function addMetadataToMessage(message, metadata) {
  message.dataset.model = metadata.model;
  message.dataset.strategy = metadata.strategy;
  message.dataset.processingTime = metadata.processing_time;
}

function toggleSidebar() {
  elements.sidebar.classList.toggle('collapsed');
}

function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);

  const sunIcon = elements.themeToggle.querySelector('.sun-icon');
  const moonIcon = elements.themeToggle.querySelector('.moon-icon');

  if (newTheme === 'dark') {
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
  } else {
    sunIcon.style.display = 'block';
    moonIcon.style.display = 'none';
  }
}

function openSettings() {
  // Populate existing settings
  elements.defaultModel.value = selectedModel;
  elements.defaultStrategy.value = selectedStrategy;
  elements.defaultTempSlider.value = temperatureValue;
  elements.defaultTemperature.value = temperatureValue;
  elements.maxTokensInput.value = maxTokens;
  elements.streamingCheckbox.checked = streamingEnabled;
  elements.settingsModal.style.display = 'flex';
}

function closeSettings() {
  elements.settingsModal.style.display = 'none';
}

function saveSettingsAndClose() {
  selectedModel = elements.defaultModel.value;
  selectedStrategy = elements.defaultStrategy.value;
  temperatureValue = parseFloat(elements.defaultTemperature.value);
  maxTokens = parseInt(elements.maxTokensInput.value);
  streamingEnabled = elements.streamingCheckbox.checked;

  updateModelInfo();
  saveSettings();
  closeSettings();
  showToast('Settings saved', 'success');
}

function openDeleteModal(messageElement) {
  messageToDelete = messageElement;
  messageIndexToDelete = parseInt(messageElement.dataset.messageIndex);
  elements.deleteModal.style.display = 'flex';
}

function closeDeleteModal() {
  elements.deleteModal.style.display = 'none';
  messageToDelete = null;
  messageIndexToDelete = null;
}

function confirmDelete() {
  if (messageToDelete && messageIndexToDelete !== null) {
    deleteMessage(messageToDelete, messageIndexToDelete);
  }
  closeDeleteModal();
}

function handleSend() {
  const query = elements.queryInput.value.trim();
  if (!query || isLoading) return;
  elements.queryInput.value = '';
  autoResizeTextarea();
  updateCharCount();
  sendQuery(query);
}

function autoResizeTextarea() {
  const ta = elements.queryInput;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
}

function updateCharCount() {
  const count = elements.queryInput.value.length;
  elements.charCount.textContent = `${count} chars`;
}

function updateModelInfo() {
  elements.modelInfo.textContent =
    `Model: ${selectedModel} • ${selectedStrategy.charAt(0).toUpperCase() + selectedStrategy.slice(1)}`;
}

function scrollToBottom() {
  elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const iconMap = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  toast.innerHTML = `
    <span class="toast-icon">${iconMap[type]}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Close">&times;</button>
  `;
  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => toast.remove());
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 5000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== Settings Persistence =====
function loadSettings() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);

  const sunIcon = elements.themeToggle.querySelector('.sun-icon');
  const moonIcon = elements.themeToggle.querySelector('.moon-icon');
  if (savedTheme === 'dark') {
    sunIcon.style.display = 'none';
    moonIcon.style.display = 'block';
  } else {
    sunIcon.style.display = 'block';
    moonIcon.style.display = 'none';
  }

  const settings = {
    model: localStorage.getItem('selectedModel') || '',
    strategy: localStorage.getItem('selectedStrategy') || 'simple',
    temperature: parseFloat(localStorage.getItem('temperature') || '0.2'),
    maxTokens: parseInt(localStorage.getItem('maxTokens') || '2048'),
    streaming: localStorage.getItem('streaming') !== 'false'
  };
  if (settings.model) selectedModel = settings.model;
  selectedStrategy = settings.strategy;
  temperatureValue = settings.temperature;
  maxTokens = settings.maxTokens;
  streamingEnabled = settings.streaming;
}

function saveSettings() {
  localStorage.setItem('selectedModel', selectedModel);
  localStorage.setItem('selectedStrategy', selectedStrategy);
  localStorage.setItem('temperature', temperatureValue.toString());
  localStorage.setItem('maxTokens', maxTokens.toString());
  localStorage.setItem('streaming', streamingEnabled.toString());
}

// ===== Cookie Utilities =====
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}
function setCookie(name, value, days) {
  let expires = '';
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
    expires = `; expires=${date.toUTCString()}`;
  }
  document.cookie = `${name}=${value}${expires}; path=/`;
}
function isMobile() {
  return window.innerWidth <= 768;
}

// ============================================================================
// Session & Sidebar History Helpers
// ============================================================================
function createNewSession() {
  elements.sessionNameInput.value = '';
  elements.sessionNameModal.style.display = 'flex';
}

function saveConversationToHistory(conversationId, sessionName) {
  if (!conversationId || !sessionName) return;
  let stored = JSON.parse(localStorage.getItem('chat_history') || '[]');
  stored = stored.filter((item) => item.id !== conversationId);
  stored.unshift({
    id: conversationId,
    name: sessionName,
    timestamp: Date.now()
  });
  stored = stored.slice(0, 20); // keep last 20 sessions
  localStorage.setItem('chat_history', JSON.stringify(stored));
}

function getConversationHistory() {
  return JSON.parse(localStorage.getItem('chat_history') || '[]');
}

function renderHistorySidebar() {
  const historyList = elements.historyList;
  historyList.innerHTML = '';

  const stored = getConversationHistory();
  stored.forEach((item) => {
    const date = new Date(item.timestamp);
    const pretty = date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.convId = item.id;
    li.innerHTML = `
      <div style="overflow: hidden;">
        <div class="history-session-name">${escapeHtml(item.name)}</div>
        <div class="history-date">${pretty}</div>
      </div>
      <button class="session-delete" aria-label="Delete session">
        <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14M10 11v6M14 11v6" />
        </svg>
      </button>
    `;

    // Clicking the item loads that conversation
    li.addEventListener('click', async () => {
      historyList.querySelectorAll('.history-item').forEach((el) => el.classList.remove('active'));
      li.classList.add('active');
      currentConversationId = item.id;
      setCookie('conversation_id', item.id, 30);
      await loadConversation(item.id);
    });

    // Delete session icon tap
    li.querySelector('.session-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(item.id);
    });

    historyList.appendChild(li);
  });
}

async function deleteSession(sessionId) {
  try {
    const response = await fetch(`${API_BASE_URL}/conversation/${sessionId}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    let stored = JSON.parse(localStorage.getItem('chat_history') || '[]');
    stored = stored.filter((item) => item.id !== sessionId);
    localStorage.setItem('chat_history', JSON.stringify(stored));

    if (currentConversationId === sessionId) {
      currentConversationId = null;
      setCookie('conversation_id', '', -1);
      elements.messagesContainer.innerHTML = `
        <div class="welcome-message">
          <h2>Welcome to NyayaGPT</h2>
          <p>Your futuristic legal AI assistant.</p>
          <p>Ask me anything about cases, statutes, or precedents!</p>
        </div>
      `;
    }

    renderHistorySidebar();
    showToast('Session deleted', 'success');
  } catch (error) {
    console.error('Error deleting session:', error);
    showToast('Failed to delete session', 'error');
  }
}

// ============================================================================
// Export for Debugging
// ============================================================================
document.addEventListener('DOMContentLoaded', init);

window.NyayaGPT = {
  version: '2.0.0',
  state: {
    get selectedModel() {
      return selectedModel;
    },
    get selectedStrategy() {
      return selectedStrategy;
    },
    get temperatureValue() {
      return temperatureValue;
    },
    get maxTokens() {
      return maxTokens;
    },
    get streamingEnabled() {
      return streamingEnabled;
    },
    get currentConversationId() {
      return currentConversationId;
    }
  },
  api: { sendQuery, clearCache, loadConversation }
};
