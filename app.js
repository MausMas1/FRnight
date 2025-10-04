const STORAGE_KEY = "frnight-activities";
const UPLOAD_STORAGE_KEY = "frnight-uploaded-ticket";
const NOW_OVERRIDE_KEY = "frnight-now-override";

const FALLBACK_PDF = "assets/frnight-placeholder.pdf";
// left/top waarden zijn CSS-pixels; een grote left (bijv. 9999) scrolt na renderen
// van de pagina effectief naar de rechterrand in PDF.js.
const DEFAULT_VIEWPORT = {
  zoom: "150",
  left: "9999",
  top: "0",
};

const WALIBI_PARK_ID = 53;
const WAIT_TIMES_ENDPOINT = `https://throbbing-heart-8a7a.harrybarry1080.workers.dev/?park=${WALIBI_PARK_ID}`;
const WAIT_TIMES_REFRESH_MS = 5 * 60 * 1000; // 5 minuten
const WAIT_TIMES_SOURCE_ENDPOINTS = [WAIT_TIMES_ENDPOINT];

const defaultActivities = [
  {
    id: "below",
    title: "Below",
    date: "2025-10-05",
    start: "2025-10-05T21:00:00",
    end: "2025-10-05T21:30:00",
    timeWindow: "21:00 - 21:30",
    pdf: FALLBACK_PDF,
    image: "assets/activitypics/Below.png",
    matchTerms: ["Below"],
  },
  {
    id: "us-vs-you",
    title: "US vs YOU",
    date: "2025-10-05",
    start: "2025-10-05T22:00:00",
    end: "2025-10-05T22:30:00",
    timeWindow: "22:00 - 22:30",
    pdf: FALLBACK_PDF,
    image: "assets/activitypics/Us vs You.png",
    matchTerms: ["US vs YOU", "US versus YOU"],
  },
  {
    id: "jefferson-manor",
    title: "Jefferson Manor",
    date: "2025-10-05",
    start: "2025-10-05T18:00:00",
    end: "2025-10-05T18:30:00",
    timeWindow: "18:00 - 18:30",
    pdf: FALLBACK_PDF,
    image: "assets/activitypics/Jefferson Manor.png",
    matchTerms: ["Jefferson Manor"],
  },
  {
    id: "psychoshockticket",
    title: "Psychochock",
    date: "2025-10-05",
    start: "2025-10-05T17:00:00",
    end: "2025-10-05T17:30:00",
    timeWindow: "17:00 - 17:30",
    pdf: FALLBACK_PDF,
    image: "assets/activitypics/Psychoshock.png",
    matchTerms: ["Psychochock", "Psycho shock"],
  },
  {
    id: "the-villa",
    title: "The Villa",
    date: "2025-10-05",
    start: "2025-10-05T16:00:00",
    end: "2025-10-05T16:30:00",
    timeWindow: "16:00 - 16:30",
    pdf: FALLBACK_PDF,
    image: "assets/activitypics/The Villa.png",
    matchTerms: ["The Villa"],
  },
  {
    id: "camp-of-curiosities",
    title: "Camp of Curiosities",
    date: "2025-10-05",
    start: "2025-10-05T18:30:00",
    end: "2025-10-05T19:00:00",
    timeWindow: "18:30 - 19:00",
    pdf: FALLBACK_PDF,
    image: "assets/activitypics/Camp of Curiosities.png",
    matchTerms: ["Camp of Curiosities"],
  },
];

const MINUTES_PER_HOUR = 60;
const EXPIRY_GRACE_MINUTES = 8;

function parseOverride(value) {
  if (!value) {
    return null;
  }
  const override = new Date(value);
  if (Number.isNaN(override.getTime())) {
    return null;
  }
  return override;
}

function now() {
  const inlineOverride = parseOverride(window.__frnightNowOverride);
  if (inlineOverride) {
    return inlineOverride;
  }

  try {
    const storedOverride = localStorage.getItem(NOW_OVERRIDE_KEY);
    const parsedStored = parseOverride(storedOverride);
    if (parsedStored) {
      return parsedStored;
    }
  } catch (error) {
    console.warn("Kon tijdsoverride niet lezen", error);
  }

  return new Date();
}

let pdfjsReadyPromise = null;
let cachedTicketDataUrl = null;
let cachedTicketObjectUrl = null;
let viewerContext = {
  baseSource: null,
  pages: [],
  currentIndex: 0,
  activityId: null,
  title: "",
  iframeReady: false,
  pendingPageNumber: null,
  iframeWindow: null,
};

let onboardingControls = null;
let lastKnownTicketState = null;

function ensurePdfJs() {
  if (pdfjsReadyPromise) {
    return pdfjsReadyPromise;
  }

  pdfjsReadyPromise = new Promise((resolve, reject) => {
    const start = performance.now();
    const timeoutMs = 4000;

    const check = () => {
      if (window.pdfjsLib) {
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";
        } catch (error) {
          console.warn("Kon pdf.js worker niet configureren", error);
        }
        resolve(window.pdfjsLib);
        return;
      }

      if (performance.now() - start > timeoutMs) {
        reject(new Error("pdf.js niet beschikbaar"));
        return;
      }

      requestAnimationFrame(check);
    };

    check();
  });

  return pdfjsReadyPromise;
}

function normalizeTerm(term) {
  return term
    .toLocaleLowerCase("nl-NL")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildPageMapFromPdf(arrayBuffer, activities) {
  const pdfjs = await ensurePdfJs();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

  const keywordMap = activities.map((activity) => {
    const baseTerms = Array.isArray(activity.matchTerms) && activity.matchTerms.length > 0
      ? activity.matchTerms
      : [activity.title];

    const normalizedTerms = baseTerms
      .map((term) => normalizeTerm(term))
      .filter((term) => term.length > 0);

    const collapsedTerms = normalizedTerms
      .map((term) => term.replace(/\s+/g, ""))
      .filter((term) => term.length > 0);

    return {
      id: activity.id,
      terms: normalizedTerms,
      collapsedTerms,
    };
  });

  const matches = new Map();
  let completedActivities = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str).join(" ");
    const normalizedText = normalizeTerm(pageText);
    const collapsedText = normalizedText.replace(/\s+/g, "");

    for (const entry of keywordMap) {
      const existing = matches.get(entry.id) || [];
      if (existing.length >= 2) {
        continue;
      }

      const hasMatch =
        entry.terms.some((term) => normalizedText.includes(term)) ||
        entry.collapsedTerms.some((term) => collapsedText.includes(term));
      if (hasMatch) {
        existing.push(pageNumber);
        matches.set(entry.id, existing);
        if (existing.length === 2) {
          completedActivities += 1;
        }
        break;
      }
    }

    if (completedActivities === keywordMap.length) {
      break;
    }
  }

  const pageMap = {};
  for (const { id } of keywordMap) {
    const pages = matches.get(id) || [];
    if (pages.length !== 2) {
      throw new Error(`Onvolledige koppeling voor activiteit ${id}`);
    }
    pageMap[id] = pages.sort((a, b) => a - b);
  }

  return pageMap;
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Ongeldige data-URL");
  }

  const meta = dataUrl.slice(0, commaIndex);
  const base64 = dataUrl.slice(commaIndex + 1);
  const mimeMatch = /data:(.*?)(;base64)?$/i.exec(meta);
  const mimeType = mimeMatch && mimeMatch[1] ? mimeMatch[1] : "application/pdf";

  const binaryString = atob(base64);
  const length = binaryString.length;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function getObjectUrlForDataUrl(dataUrl) {
  if (cachedTicketDataUrl === dataUrl && cachedTicketObjectUrl) {
    return cachedTicketObjectUrl;
  }

  if (cachedTicketObjectUrl) {
    URL.revokeObjectURL(cachedTicketObjectUrl);
    cachedTicketObjectUrl = null;
  }

  const blob = dataUrlToBlob(dataUrl);
  cachedTicketObjectUrl = URL.createObjectURL(blob);
  cachedTicketDataUrl = dataUrl;
  return cachedTicketObjectUrl;
}

function resetCachedTicketObjectUrl() {
  if (cachedTicketObjectUrl) {
    URL.revokeObjectURL(cachedTicketObjectUrl);
    cachedTicketObjectUrl = null;
  }
  cachedTicketDataUrl = null;
}

function isPdfViewerOpen() {
  const viewer = document.querySelector("[data-pdf-viewer]");
  return Boolean(viewer && !viewer.classList.contains("is-hidden"));
}

function isUploadModalOpen() {
  const modal = document.querySelector("[data-upload-modal]");
  return Boolean(modal && !modal.classList.contains("is-hidden"));
}

function isWaitTimesModalOpen() {
  const modal = document.querySelector("[data-waittimes-modal]");
  return Boolean(modal && !modal.classList.contains("is-hidden"));
}

function restoreBodyScrollIfNoOverlay() {
  if (!isPdfViewerOpen() && !isUploadModalOpen() && !isWaitTimesModalOpen()) {
    document.body.style.overflow = "";
  }
}

function setViewerContext(partial) {
  viewerContext = {
    baseSource: null,
    pages: [],
    currentIndex: 0,
    activityId: null,
    title: "",
    iframeReady: false,
    pendingPageNumber: null,
    iframeWindow: null,
    ...partial,
  };
}

function getViewerIframe() {
  const viewer = document.querySelector("[data-pdf-viewer]");
  if (!viewer) {
    return null;
  }
  const iframe = viewer.querySelector("[data-pdf-iframe]");
  return iframe instanceof HTMLIFrameElement ? iframe : null;
}

function updateViewerNavigation() {
  const nav = document.querySelector("[data-viewer-nav]");
  const label = document.querySelector("[data-viewer-label]");
  const prevBtn = document.querySelector("[data-viewer-prev]");
  const nextBtn = document.querySelector("[data-viewer-next]");

  if (!nav || !label || !prevBtn || !nextBtn) {
    return;
  }

  if (!viewerContext.pages.length) {
    nav.hidden = true;
    return;
  }

  nav.hidden = viewerContext.pages.length <= 1;
  const position = viewerContext.currentIndex + 1;
  label.textContent = `Ticket ${position}/${viewerContext.pages.length}`;
  prevBtn.disabled = viewerContext.currentIndex <= 0;
  nextBtn.disabled = viewerContext.currentIndex >= viewerContext.pages.length - 1;
}

function setViewerPage(index) {
  if (!viewerContext.baseSource || !viewerContext.pages.length) {
    updateViewerNavigation();
    return;
  }

  const clampedIndex = Math.max(0, Math.min(index, viewerContext.pages.length - 1));
  viewerContext.currentIndex = clampedIndex;
  const page = viewerContext.pages[clampedIndex];

  updateViewerNavigation();
  if (!page) {
    viewerContext.pendingPageNumber = null;
    return;
  }

  viewerContext.pendingPageNumber = page;
  applyPendingViewerPage();
}

function navigateViewer(delta) {
  if (!viewerContext.pages.length) {
    return;
  }

  const nextIndex = viewerContext.currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= viewerContext.pages.length) {
    return;
  }

  setViewerPage(nextIndex);
}

function applyPendingViewerPage() {
  if (!viewerContext.pendingPageNumber) {
    return;
  }

  const iframe = getViewerIframe();
  const iframeWindow = iframe?.contentWindow;
  const app = iframeWindow?.PDFViewerApplication;
  if (!app) {
    return;
  }

  const desiredPage = viewerContext.pendingPageNumber;

  const setPage = () => {
    try {
      app.page = desiredPage;
      viewerContext.pendingPageNumber = null;
    } catch (error) {
      console.warn("Kon pagina niet instellen in viewer", error);
    }
  };

  if (app.pdfViewer?.pagesCount) {
    setPage();
    return;
  }

  if (app.eventBus) {
    const onceHandler = () => {
      setPage();
    };
    app.eventBus.on("pagesloaded", onceHandler, { once: true });
  }
}

async function handleViewerFrameLoad() {
  const iframe = getViewerIframe();
  const iframeWindow = iframe?.contentWindow;
  if (!iframe || !iframeWindow) {
    return;
  }

  viewerContext.iframeWindow = iframeWindow;

  const app = iframeWindow.PDFViewerApplication;
  if (!app) {
    viewerContext.iframeReady = false;
    return;
  }

  try {
    await app.initializedPromise;
    viewerContext.iframeReady = true;
  } catch (error) {
    console.warn("Kon pdf.js viewer niet initialiseren", error);
    viewerContext.iframeReady = false;
    return;
  }

  updateViewerNavigation();
  applyPendingViewerPage();
}

function loadStoredTicket() {
  const raw = localStorage.getItem(UPLOAD_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (typeof parsed.dataUrl !== "string" || parsed.dataUrl.length === 0) {
      return null;
    }

    let pageMap = null;
    if (parsed.pageMap && typeof parsed.pageMap === "object") {
      pageMap = {};
      for (const [activityId, pages] of Object.entries(parsed.pageMap)) {
        if (!Array.isArray(pages)) {
          continue;
        }
        const numericPages = pages
          .map((page) => Number.parseInt(page, 10))
          .filter((page) => Number.isInteger(page) && page > 0)
          .sort((a, b) => a - b);
        if (numericPages.length) {
          pageMap[activityId] = numericPages;
        }
      }
    }

    return {
      name: typeof parsed.name === "string" ? parsed.name : "Geüploade tickets",
      dataUrl: parsed.dataUrl,
      uploadedAt:
        typeof parsed.uploadedAt === "string" ? parsed.uploadedAt : new Date().toISOString(),
      pageMap,
    };
  } catch (error) {
    console.warn("Kon geüploade tickets niet lezen", error);
    return null;
  }
}

function saveStoredTicket(record) {
  resetCachedTicketObjectUrl();
  localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(record));
}

function getStartTimestamp(activity) {
  if (!activity || typeof activity.start !== "string") {
    return Number.POSITIVE_INFINITY;
  }

  const date = new Date(activity.start);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

// Leest bestaande activiteiten uit localStorage, of valt terug op de defaults.
function loadActivities() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return defaultActivities;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return defaultActivities;
    }
    const hasRequiredShape = parsed.every((activity) => {
      if (!activity || typeof activity !== "object") {
        return false;
      }

      const hasPdf =
        typeof activity.pdf === "undefined" || typeof activity.pdf === "string";

      const hasMatchTerms =
        typeof activity.matchTerms === "undefined" ||
        (Array.isArray(activity.matchTerms) &&
          activity.matchTerms.every((term) => typeof term === "string"));

      const hasImage =
        typeof activity.image === "undefined" || typeof activity.image === "string";

      return (
        typeof activity.id === "string" &&
        typeof activity.title === "string" &&
        typeof activity.timeWindow === "string" &&
        typeof activity.date === "string" &&
        typeof activity.start === "string" &&
        typeof activity.end === "string" &&
        hasPdf &&
        hasMatchTerms &&
        hasImage
      );
    });

    return hasRequiredShape ? parsed : defaultActivities;
  } catch (error) {
    console.warn("Kon activiteiten niet laden, gebruik defaults", error);
    return defaultActivities;
  }
}

// Scherpt de structuur voor toekomstige mutaties.
function saveActivities(activities) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(activities));
}

function minutesUntilStart(startTime) {
  if (!startTime) {
    return null;
  }

  const nowValue = now();
  const start = new Date(startTime);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const diffMinutes = (start - nowValue) / 60000;
  if (diffMinutes > 0) {
    return Math.ceil(diffMinutes);
  }
  if (diffMinutes < 0) {
    return Math.floor(diffMinutes);
  }
  return 0;
}

function createStatusBadge(activity) {
  const minutes = minutesUntilStart(activity.start);
  const badge = document.createElement("span");
  badge.className = "status-badge";

  if (minutes === null) {
    badge.textContent = "Onbekende start";
    badge.classList.add("status-unknown");
    return { badge, minutes, status: "unknown" };
  }

  if (minutes < 0) {
    badge.textContent = `${Math.abs(minutes)} min geleden`;
    badge.classList.add("status-past");
    return { badge, minutes, status: "past" };
  }

  if (minutes <= MINUTES_PER_HOUR) {
    badge.textContent = minutes === 0 ? "Start nu" : `Nog ${minutes} min`;
    badge.classList.add("status-soon");
    return { badge, minutes, status: "soon" };
  }

  badge.textContent = `Nog ${minutes} min`;
  badge.classList.add("status-upcoming");
  return { badge, minutes, status: "upcoming" };
}

function getActivityImage(activity) {
  if (activity && typeof activity.image === "string" && activity.image.trim().length > 0) {
    return activity.image;
  }

  const fallback = defaultActivities.find((entry) => entry.id === activity?.id);
  if (fallback && typeof fallback.image === "string" && fallback.image.trim().length > 0) {
    return fallback.image;
  }

  return null;
}

function createActivityThumbnail(activity) {
  const imagePath = getActivityImage(activity);
  if (!imagePath) {
    return null;
  }

  const img = document.createElement("img");
  img.className = "calendar-thumb";
  img.src = imagePath;
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.decoding = "async";
  img.loading = "lazy";
  return img;
}

function setupOnboardingFlow() {
  const container = document.querySelector("[data-onboarding]");
  if (!container) {
    onboardingControls = null;
    return;
  }

  const checkbox = container.querySelector("[data-onboarding-confirm]");
  const confirmStep = container.querySelector('[data-onboarding-step="confirm"]');
  const successStep = container.querySelector('[data-onboarding-step="success"]');
  const uploadButton = container.querySelector("[data-onboarding-upload]") || container.querySelector("[data-upload-trigger]");

  const apply = (checked) => {
    if (confirmStep) {
      confirmStep.classList.toggle("is-hidden", checked);
    }
    if (successStep) {
      successStep.classList.toggle("is-hidden", !checked);
    }
    container.classList.toggle("onboarding--success", checked);
  };

  const reset = () => {
    if (checkbox instanceof HTMLInputElement) {
      checkbox.checked = false;
    }
    apply(false);
  };

  const handleChange = () => {
    const checked = checkbox instanceof HTMLInputElement && checkbox.checked;
    apply(checked);

    if (checked && uploadButton instanceof HTMLElement) {
      window.setTimeout(() => {
        uploadButton.focus();
      }, 120);
    }
  };

  if (checkbox instanceof HTMLInputElement) {
    checkbox.addEventListener("change", handleChange);
  }

  onboardingControls = { container, checkbox, apply, reset };
  apply(checkbox instanceof HTMLInputElement ? checkbox.checked : false);
}

function resetOnboardingFlow() {
  if (onboardingControls && typeof onboardingControls.reset === "function") {
    onboardingControls.reset();
  }
}

function renderActivities(activities) {
  const list = document.querySelector("[data-calendar-list]");
  if (!list) {
    return;
  }

  list.innerHTML = "";

  const nowValue = now();

  const sortedActivities = [...activities].sort((a, b) => {
    const aStart = new Date(a.start);
    const bStart = new Date(b.start);
    const aEndsAt = new Date(a.end || a.start);
    const bEndsAt = new Date(b.end || b.start);

    const aExpired =
      !Number.isNaN(aEndsAt.getTime()) &&
      (nowValue.getTime() - aEndsAt.getTime()) / 60000 > EXPIRY_GRACE_MINUTES;
    const bExpired =
      !Number.isNaN(bEndsAt.getTime()) &&
      (nowValue.getTime() - bEndsAt.getTime()) / 60000 > EXPIRY_GRACE_MINUTES;

    if (aExpired && !bExpired) {
      return 1;
    }
    if (!aExpired && bExpired) {
      return -1;
    }

    const aTimestamp = getStartTimestamp(a);
    const bTimestamp = getStartTimestamp(b);
    return aTimestamp - bTimestamp;
  });

  let nextUpcomingAssigned = false;
  const storedTicket = loadStoredTicket();

  for (const activity of sortedActivities) {
    const item = document.createElement("li");
    item.className = "calendar-item";
    item.dataset.activityId = activity.id;
    if (activity.date) {
      item.dataset.date = activity.date;
    }
    if (activity.start) {
      item.dataset.start = activity.start;
    }
    if (activity.pdf) {
      item.dataset.pdf = activity.pdf;
    }
    if (storedTicket?.pageMap?.[activity.id]) {
      item.dataset.ticketPages = storedTicket.pageMap[activity.id].join(",");
    }

    const heading = document.createElement("h3");
    heading.className = "calendar-title";
    heading.textContent = activity.title;

    const description = document.createElement("p");
    description.className = "calendar-time";
    const timeText = activity.timeWindow || "Tijd nog onbekend";
    description.textContent = timeText;

    const { badge: statusBadge, minutes } = createStatusBadge(activity);
    const thumbnail = createActivityThumbnail(activity);

    if (!nextUpcomingAssigned && typeof minutes === "number" && minutes >= 0) {
      statusBadge.classList.add("status-pulsing");
      nextUpcomingAssigned = true;
    }

    const info = document.createElement("div");
    info.className = "calendar-info";
    info.append(heading, description);

    const layout = document.createElement("div");
    layout.className = "calendar-layout";
    if (thumbnail) {
      layout.append(thumbnail);
    }
    layout.append(info, statusBadge);

    item.append(layout);
    list.append(item);
  }

  if (!list.dataset.listenerAttached) {
    list.addEventListener("click", handleActivityClick);
    list.dataset.listenerAttached = "true";
  }
}

function handleActivityClick(event) {
  const target = event.target.closest(".calendar-item");
  if (!target) {
    return;
  }

  const pdf = target.dataset.pdf || "";
  const heading = target.querySelector("h3");
  const title = heading ? heading.textContent : "Activiteit";
  const storedTicket = loadStoredTicket();
  const activityId = target.dataset.activityId;

  const resolvedPdf =
    pdf && pdf !== FALLBACK_PDF
      ? pdf
      : storedTicket?.dataUrl || pdf || FALLBACK_PDF;

  showPdfViewer(resolvedPdf, title, activityId).catch((error) => {
    console.error("Kon pdf-viewer niet openen", error);
  });
}

async function showPdfViewer(pdfUrl, title, activityId = null) {
  const viewer = document.querySelector("[data-pdf-viewer]");
  const iframe = viewer?.querySelector("[data-pdf-iframe]");
  if (!viewer || !(iframe instanceof HTMLIFrameElement)) {
    return;
  }

  const storedTicket = loadStoredTicket();
  let source = typeof pdfUrl === "string" ? pdfUrl.trim() : "";
  if (!source) {
    source = storedTicket?.dataUrl || FALLBACK_PDF;
  }
  if (source === FALLBACK_PDF && storedTicket?.dataUrl) {
    source = storedTicket.dataUrl;
  }

  if (source.startsWith("data:")) {
    try {
      source = getObjectUrlForDataUrl(source);
    } catch (error) {
      console.error("Kon data-URL niet converteren", error);
    }
  }

  const baseSource = source.split("#")[0];
  const pageNumbers =
    activityId && storedTicket?.pageMap?.[activityId]?.length
      ? [...new Set(storedTicket.pageMap[activityId])]
          .map((page) => Number.parseInt(page, 10))
          .filter((page) => Number.isInteger(page) && page > 0)
          .sort((a, b) => a - b)
      : [];

  const viewerUrl = new URL("assets/pdfjs/web/viewer.html", window.location.href);
  viewerUrl.searchParams.set("file", baseSource);
  if (pageNumbers.length > 0) {
    const hasViewport =
      typeof DEFAULT_VIEWPORT !== "undefined" &&
      DEFAULT_VIEWPORT &&
      typeof DEFAULT_VIEWPORT.zoom !== "undefined";

    if (
      hasViewport &&
      typeof DEFAULT_VIEWPORT.left !== "undefined" &&
      typeof DEFAULT_VIEWPORT.top !== "undefined"
    ) {
      viewerUrl.hash = `page=${pageNumbers[0]}&zoom=${DEFAULT_VIEWPORT.zoom},${DEFAULT_VIEWPORT.left},${DEFAULT_VIEWPORT.top}`;
    } else {
      viewerUrl.hash = `page=${pageNumbers[0]}`;
    }
  } else {
    viewerUrl.hash = "";
  }

  iframe.src = viewerUrl.toString();

  setViewerContext({
    baseSource,
    pages: pageNumbers,
    currentIndex: 0,
    activityId,
    title,
    iframeReady: false,
    pendingPageNumber: pageNumbers[0] || null,
    iframeWindow: null,
  });

  if (viewerContext.pages.length > 0) {
    setViewerPage(0);
  } else {
    updateViewerNavigation();
  }

  viewer.classList.remove("is-hidden");
  viewer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  const closeButton = viewer.querySelector(".pdf-viewer__close");
  if (closeButton instanceof HTMLElement) {
    closeButton.focus({ preventScroll: true });
  }
}

function hidePdfViewer() {
  const viewer = document.querySelector("[data-pdf-viewer]");
  const iframe = getViewerIframe();
  if (!viewer || !iframe) {
    return;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && viewer.contains(activeElement)) {
    activeElement.blur();
  }

  iframe.src = "about:blank";
  viewerContext.pendingPageNumber = null;
  viewerContext.iframeReady = false;
  viewerContext.iframeWindow = null;
  viewer.classList.add("is-hidden");
  viewer.setAttribute("aria-hidden", "true");
  restoreBodyScrollIfNoOverlay();

  setViewerContext({});
  updateViewerNavigation();
}

function setupPdfViewer() {
  const viewer = document.querySelector("[data-pdf-viewer]");
  if (!viewer) {
    return;
  }

  const closeElements = viewer.querySelectorAll("[data-close-viewer]");
  closeElements.forEach((element) => {
    element.addEventListener("click", hidePdfViewer);
  });

  const prevBtn = viewer.querySelector("[data-viewer-prev]");
  const nextBtn = viewer.querySelector("[data-viewer-next]");
  prevBtn?.addEventListener("click", () => navigateViewer(-1));
  nextBtn?.addEventListener("click", () => navigateViewer(1));

  const iframe = getViewerIframe();
  if (iframe) {
    iframe.addEventListener("load", handleViewerFrameLoad);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !viewer.classList.contains("is-hidden")) {
      hidePdfViewer();
    }
    if (event.key === "ArrowLeft" && !viewer.classList.contains("is-hidden")) {
      navigateViewer(-1);
    }
    if (event.key === "ArrowRight" && !viewer.classList.contains("is-hidden")) {
      navigateViewer(1);
    }
  });
}

function setupUploadFlow() {
  const triggers = Array.from(document.querySelectorAll("[data-upload-trigger]"));
  const modal = document.querySelector("[data-upload-modal]");
  if (triggers.length === 0 || !modal) {
    return;
  }

  const form = modal.querySelector("[data-upload-form]");
  const input = modal.querySelector("[data-upload-input]");
  const feedback = modal.querySelector("[data-upload-feedback]");
  let lastTrigger = null;

  const setFeedback = (message, variant = "info") => {
    if (!feedback) {
      return;
    }

    feedback.textContent = message;
    feedback.classList.toggle("is-error", variant === "error");
  };

  const openModal = () => {
    const stored = loadStoredTicket();
    if (stored) {
      setFeedback(`Laatste upload: ${stored.name}`, "info");
    } else {
      setFeedback("", "info");
    }

    modal.classList.remove("is-hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  };

  const focusReturnTarget = () => {
    const candidates = [lastTrigger, ...triggers];
    const target = candidates.find((element) => element instanceof HTMLElement && !element.hasAttribute("hidden"));
    if (target) {
      target.focus();
    }
    lastTrigger = null;
  };

  const closeModal = () => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && modal.contains(activeElement)) {
      activeElement.blur();
    }

    modal.classList.add("is-hidden");
    modal.setAttribute("aria-hidden", "true");
    restoreBodyScrollIfNoOverlay();
    form?.reset();
    setFeedback("", "info");
    focusReturnTarget();
  };

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      lastTrigger = trigger;
      openModal();
    });
  });

  const closers = modal.querySelectorAll("[data-close-upload]");
  closers.forEach((element) => {
    element.addEventListener("click", closeModal);
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!input || !input.files || input.files.length === 0) {
      setFeedback("Kies een PDF om te uploaden.", "error");
      return;
    }

    const file = input.files[0];
    if (file.type !== "application/pdf") {
      setFeedback("Alleen PDF-bestanden zijn toegestaan.", "error");
      return;
    }

    if (file.size > 7 * 1024 * 1024) {
      setFeedback("Bestand is te groot. Kies een PDF kleiner dan 7 MB.", "error");
      return;
    }

    setFeedback("Bezig met uploaden...", "info");

    try {
      const [arrayBuffer, dataUrl] = await Promise.all([
        readFileAsArrayBuffer(file),
        readFileAsDataUrl(file),
      ]);

      const activitiesForMapping = loadActivities();
      const pageMap = await buildPageMapFromPdf(arrayBuffer, activitiesForMapping);

      const record = {
        name: file.name,
        dataUrl,
        uploadedAt: new Date().toISOString(),
        pageMap,
      };

      saveStoredTicket(record);

      renderActivities(activitiesForMapping);
      syncUiState();

      closeModal();
      showPdfViewer(dataUrl, file.name).catch((error) => {
        console.error("Kon geüploade PDF niet tonen", error);
      });
    } catch (error) {
      console.error("Upload of parsing mislukt", error);
      setFeedback("Ruben is dik!", "error");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("is-hidden")) {
      closeModal();
    }
  });
}

function setupOriginalFileButton() {
  const button = document.querySelector("[data-view-original]");
  if (!(button instanceof HTMLElement)) {
    return;
  }

  button.addEventListener("click", () => {
    const storedTicket = loadStoredTicket();
    if (!storedTicket) {
      return;
    }

    let source = storedTicket.dataUrl || "";
    if (!source) {
      return;
    }

    if (source.startsWith("data:")) {
      try {
        source = getObjectUrlForDataUrl(source);
      } catch (error) {
        console.error("Kon data-URL niet voorbereiden voor weergave", error);
        return;
      }
    }

    const anchor = document.createElement("a");
    anchor.href = source;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    window.setTimeout(() => {
      anchor.remove();
    }, 0);
  });
}

function syncUiState() {
  const storedTicket = loadStoredTicket();
  const hasTicket = Boolean(storedTicket);
  const onboarding = document.querySelector("[data-onboarding]");
  const calendar = document.querySelector("[data-calendar]");
  const calendarTrigger = document.querySelector("[data-calendar-upload]");
  const viewOriginalButton = document.querySelector("[data-view-original]");

  if (lastKnownTicketState !== hasTicket) {
    if (!hasTicket) {
      resetOnboardingFlow();
    }
    lastKnownTicketState = hasTicket;
  }

  if (onboarding) {
    onboarding.classList.toggle("is-hidden", hasTicket);
  }
  if (calendar) {
    calendar.classList.toggle("is-hidden", !hasTicket);
    if (!hasTicket) {
      calendar.scrollTop = 0;
    }
  }
  if (calendarTrigger instanceof HTMLElement) {
    calendarTrigger.hidden = !hasTicket;
  }
  if (viewOriginalButton instanceof HTMLElement) {
    viewOriginalButton.hidden = !hasTicket;
  }
}

function activateBatBubble() {
  const bats = document.querySelectorAll(".bat");
  if (bats.length === 0) {
    return;
  }

  const randomIndex = Math.floor(Math.random() * bats.length);
  const luckyBat = bats[randomIndex];
  luckyBat.classList.add("bat--with-bubble");
}

function setupWaitTimesWidget() {
  const trigger = document.querySelector("[data-waittimes-open]");
  const modal = document.querySelector("[data-waittimes-modal]");
  if (!(trigger instanceof HTMLElement) || !modal) {
    return;
  }

  const dialog = modal.querySelector("[data-waittimes-dialog]");
  const content = modal.querySelector("[data-waittimes-content]");
  const statusElement = modal.querySelector("[data-waittimes-status]");
  const updatedElement = modal.querySelector("[data-waittimes-updated]");
  const closeElements = modal.querySelectorAll("[data-waittimes-close]");

  let refreshTimer = null;
  let isFetching = false;
  let hasRendered = false;
  let lastFocusTarget = trigger;

  const setStatus = (message, variant = "info") => {
    if (!(statusElement instanceof HTMLElement)) {
      return;
    }

    if (!message || !message.trim()) {
      statusElement.textContent = "";
      delete statusElement.dataset.variant;
      return;
    }

    statusElement.textContent = message;
    statusElement.dataset.variant = variant;
  };

  const formatTimeLabel = (value) => {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
    }

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    return null;
  };

  const flattenRides = (payload) => {
    if (!payload || typeof payload !== "object") {
      return [];
    }

    const fromLands = Array.isArray(payload.lands)
      ? payload.lands.flatMap((land) => (Array.isArray(land?.rides) ? land.rides : []))
      : [];
    const direct = Array.isArray(payload.rides) ? payload.rides : [];
    const combined = [...fromLands, ...direct].filter((ride) => ride && typeof ride === "object");

    const seen = new Set();
    const result = [];
    for (const ride of combined) {
      const identifier =
        (ride.id && String(ride.id)) ||
        (ride.ride_id && String(ride.ride_id)) ||
        (ride.slug && String(ride.slug)) ||
        (ride.name && String(ride.name));

      if (identifier && seen.has(identifier)) {
        continue;
      }
      if (identifier) {
        seen.add(identifier);
      }
      result.push(ride);
    }

    return result;
  };

  const sortRides = (rides) => {
    return [...rides].sort((a, b) => {
      const aOpen = Boolean(a?.is_open);
      const bOpen = Boolean(b?.is_open);
      if (aOpen !== bOpen) {
        return aOpen ? -1 : 1;
      }

      const normalizeWait = (ride) => {
        const wait = ride?.wait_time;
        if (typeof wait === "number" && Number.isFinite(wait) && wait >= 0) {
          return wait;
        }
        return Number.NEGATIVE_INFINITY;
      };

      const waitDiff = normalizeWait(b) - normalizeWait(a);
      if (waitDiff !== 0) {
        return waitDiff;
      }

      const aName = typeof a?.name === "string" ? a.name : "";
      const bName = typeof b?.name === "string" ? b.name : "";
      return aName.localeCompare(bName, "nl-NL", { sensitivity: "base" });
    });
  };

  const renderWaitTimes = (rides) => {
    if (!(content instanceof HTMLElement)) {
      return;
    }

    content.innerHTML = "";
    if (!rides.length) {
      const empty = document.createElement("p");
      empty.className = "wait-times__empty";
      empty.textContent = "Geen wachttijden gevonden.";
      content.append(empty);
      return;
    }

    const list = document.createElement("ul");
    list.className = "wait-times__list";

    const sorted = sortRides(rides);
    for (const ride of sorted) {
      const item = document.createElement("li");
      item.className = "wait-times__item";

      const header = document.createElement("div");
      header.className = "wait-times__item-header";

      const name = document.createElement("span");
      name.className = "wait-times__item-name";
      name.textContent = typeof ride?.name === "string" ? ride.name : "Onbekende attractie";

      const badge = document.createElement("span");
      badge.className = "wait-times__badge";
      const statusLabel =
        ride?.is_open
          ? "Open"
          : typeof ride?.status === "string" && ride.status.trim()
            ? ride.status.trim()
            : "Gesloten";
      badge.classList.add(ride?.is_open ? "is-open" : "is-closed");
      badge.textContent = statusLabel;

      header.append(name, badge);

      const meta = document.createElement("div");
      meta.className = "wait-times__item-meta";

      const waitLabel = document.createElement("span");
      waitLabel.className = "wait-times__time";
      if (typeof ride?.wait_time === "number" && Number.isFinite(ride.wait_time) && ride.wait_time >= 0) {
        waitLabel.textContent = `${ride.wait_time} min`;
      } else if (typeof ride?.wait_time === "string" && ride.wait_time.trim()) {
        waitLabel.textContent = ride.wait_time.trim();
      } else {
        waitLabel.textContent = ride?.is_open ? "Onbekend" : "—";
      }

      const updated = document.createElement("span");
      updated.className = "wait-times__updated";
      const rideUpdate = formatTimeLabel(ride?.last_updated);
      updated.textContent = rideUpdate ? `Laatste update: ${rideUpdate}` : "Laatste update onbekend";

      meta.append(waitLabel, updated);
      item.append(header, meta);
      list.append(item);
    }

    content.append(list);
  };

  const formatUpdatedLabel = (payload) => {
    if (!(updatedElement instanceof HTMLElement)) {
      return;
    }

    const candidates = [];
    if (payload && typeof payload === "object") {
      if (typeof payload.last_updated === "string") {
        candidates.push(payload.last_updated);
      }
      if (typeof payload.last_update === "string") {
        candidates.push(payload.last_update);
      }
      if (typeof payload.generated_at === "string") {
        candidates.push(payload.generated_at);
      }
      if (payload.status && typeof payload.status === "object") {
        if (typeof payload.status.generated_at === "string") {
          candidates.push(payload.status.generated_at);
        }
        if (typeof payload.status.timestamp === "string") {
          candidates.push(payload.status.timestamp);
        }
      }
    }

    for (const candidate of candidates) {
      const label = formatTimeLabel(candidate);
      if (label) {
        updatedElement.textContent = `Bijgewerkt: ${label}`;
        return;
      }
    }

    updatedElement.textContent = `Bijgewerkt: ${new Date().toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  };

  const fetchWaitTimesPayload = async () => {
    const errors = [];

    for (const source of WAIT_TIMES_SOURCE_ENDPOINTS) {
      try {
        const response = await fetch(source, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();
        const trimmed = typeof text === "string" ? text.trim() : "";
        if (!trimmed) {
          throw new Error("Leeg antwoord");
        }

        return JSON.parse(trimmed);
      } catch (error) {
        errors.push({ source, error });
        console.warn(`Kon wachttijden niet laden via ${source}`, error);
      }
    }

    const aggregateError = new Error("Kon wachttijden niet laden via beschikbare bronnen.");
    aggregateError.details = errors;
    throw aggregateError;
  };

  const refreshWaitTimes = async () => {
    if (isFetching) {
      return;
    }
    isFetching = true;

    if (!hasRendered) {
      setStatus("Wachttijden laden...", "loading");
    }

    try {
      const payload = await fetchWaitTimesPayload();
      const rides = flattenRides(payload);
      renderWaitTimes(rides);
      formatUpdatedLabel(payload);
      setStatus("", "info");
      hasRendered = true;
    } catch (err) {
      console.error("Kon wachttijden niet laden", err);
      if (content instanceof HTMLElement && !hasRendered) {
        content.textContent = "Kon wachttijden niet laden.";
      }
      const message = hasRendered
        ? "Kon wachttijden niet verversen."
        : "Kon wachttijden niet laden.";
      setStatus(message, "error");
      if (updatedElement instanceof HTMLElement) {
        updatedElement.textContent = "";
      }
    } finally {
      isFetching = false;
    }
  };

  const openModal = (ride) => {
    if (!ride) {
      console.warn("openModal: geen ride (data niet geladen?)");
      return;
    }

    if (isWaitTimesModalOpen()) {
      return;
    }

    if (document.activeElement instanceof HTMLElement) {
      lastFocusTarget = document.activeElement;
    }

    modal.classList.remove("is-hidden");
    modal.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";

    window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(refreshWaitTimes, WAIT_TIMES_REFRESH_MS);
    refreshWaitTimes();

    if (dialog instanceof HTMLElement) {
      dialog.focus({ preventScroll: true });
    }
  };

  const closeModal = () => {
    if (!isWaitTimesModalOpen()) {
      return;
    }

    window.clearInterval(refreshTimer);
    refreshTimer = null;

    modal.classList.add("is-hidden");
    modal.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    restoreBodyScrollIfNoOverlay();

    const target =
      lastFocusTarget instanceof HTMLElement && document.body.contains(lastFocusTarget)
        ? lastFocusTarget
        : trigger;
    window.setTimeout(() => {
      try {
        target.focus({ preventScroll: true });
      } catch (error) {
        target.focus();
      }
    }, 0);
  };

  trigger.addEventListener("click", () => {
    if (isWaitTimesModalOpen()) {
      closeModal();
    } else {
      openModal({ id: "wait-times" });
    }
  });

  closeElements.forEach((element) => {
    element.addEventListener("click", () => {
      closeModal();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isWaitTimesModalOpen()) {
      event.preventDefault();
      closeModal();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const activities = loadActivities();
  renderActivities(activities);

  // Bewaar de data alvast zodat toekomstige wijzigingen een startpunt hebben.
  saveActivities(activities);

  setupPdfViewer();
  setupOnboardingFlow();
  setupUploadFlow();
  setupOriginalFileButton();
  setupWaitTimesWidget();
  syncUiState();
  activateBatBubble();

  if (typeof window !== "undefined") {
    window.__frnightTestOverride = (value) => {
      if (!value) {
        window.__frnightNowOverride = null;
        try {
          localStorage.removeItem(NOW_OVERRIDE_KEY);
        } catch (error) {
          console.warn("Kon tijdsoverride niet verwijderen", error);
        }
      } else {
        window.__frnightNowOverride = value;
        try {
          localStorage.setItem(NOW_OVERRIDE_KEY, value);
        } catch (error) {
          console.warn("Kon tijdsoverride niet opslaan", error);
        }
      }

      renderActivities(loadActivities());
    };
  }
});
