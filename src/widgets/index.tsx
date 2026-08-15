import { declareIndexPlugin, ReactRNPlugin, BuiltInPowerupCodes } from '@remnote/plugin-sdk';

const DESTINATION_URL = 'http://127.0.0.1:8000';
let lastSentCardId: string | null = null;
let isSyncing = false;

// MARK: - 1. DOM & Image Helpers

function getAllDocumentsOnPage(): Document[] {
  const docs: Document[] = [];
  try { if (typeof document !== 'undefined') docs.push(document); } catch (e) {}
  try { if (window.parent?.document && !docs.includes(window.parent.document)) docs.push(window.parent.document); } catch (e) {}
  try { if (window.top?.document && !docs.includes(window.top.document)) docs.push(window.top.document); } catch (e) {}

  try {
    if (window.top?.frames) {
      for (let i = 0; i < window.top.frames.length; i++) {
        try {
          const fDoc = window.top.frames[i].document;
          if (fDoc && !docs.includes(fDoc)) {
            docs.push(fDoc);
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  return docs;
}

function findImgElementByFilename(filename: string): HTMLImageElement | null {
  if (!filename) return null;
  const cleanName = filename.replace('%LOCAL_FILE%', '').split('?')[0];
  const shortName = cleanName.length > 15 ? cleanName.slice(0, 15) : cleanName;

  const docs = getAllDocumentsOnPage();
  for (const doc of docs) {
    try {
      const imgs = Array.from(doc.querySelectorAll('img'));
      for (const img of imgs) {
        if (img.src && (img.src.includes(cleanName) || img.src.includes(shortName))) {
          return img as HTMLImageElement;
        }
      }
    } catch (e) {}
  }
  return null;
}

function getBase64FromImageElement(img: HTMLImageElement): string {
  try {
    if (!img.complete || img.naturalWidth === 0) return '';
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width || 300;
    canvas.height = img.naturalHeight || img.height || 300;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      if (dataUrl && dataUrl.startsWith('data:image')) {
        return dataUrl;
      }
    }
  } catch (e) {}
  return '';
}

async function fetchUrlAsBase64(url: string): Promise<string> {
  try {
    const response = await fetch(url).catch(() => null);
    if (!response || !response.ok) return '';
    const blob = await response.blob();

    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        if (result && result.startsWith('data:image')) {
          resolve(result);
        } else {
          resolve('');
        }
      };
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return '';
  }
}

async function resolveAndConvertImageToBase64(imageUrl: string): Promise<string> {
  if (!imageUrl) return '';
  if (imageUrl.startsWith('data:image/')) return imageUrl;

  const isLocalFile = imageUrl.includes('%LOCAL_FILE%');
  const filename = isLocalFile ? imageUrl.replace('%LOCAL_FILE%', '') : imageUrl;

  const imgElement = findImgElementByFilename(filename);
  if (imgElement) {
    const canvasB64 = getBase64FromImageElement(imgElement);
    if (canvasB64) return canvasB64;

    if (imgElement.src && imgElement.src !== imageUrl) {
      const fetchB64 = await fetchUrlAsBase64(imgElement.src);
      if (fetchB64) return fetchB64;
    }
  }

  if (isLocalFile) {
    const candidateUrls = [
      `https://remnote-user-data.s3.amazonaws.com/${filename}`,
      `https://cdn.remnote.com/${filename}`,
      `https://www.remnote.com/files/${filename}`
    ];

    for (const candUrl of candidateUrls) {
      const b64 = await fetchUrlAsBase64(candUrl);
      if (b64) return b64;
    }
  } else {
    const b64 = await fetchUrlAsBase64(imageUrl);
    if (b64) return b64;
  }

  return '';
}

function findImageUrlsInObject(obj: any, foundUrls = new Set<string>()): Set<string> {
  if (!obj) return foundUrls;

  if (typeof obj === 'string') {
    if (obj.startsWith('data:image/')) {
      foundUrls.add(obj);
      return foundUrls;
    }

    if (obj.includes('%LOCAL_FILE%')) {
      const match = obj.match(/%LOCAL_FILE%[^\s"'<>\)]+/gi);
      if (match) {
        for (const m of match) {
          foundUrls.add(m);
        }
      }
    }

    const urlRegex = /(https?:\/\/[^\s"'<>\)]+|blob:[^\s"'<>\)]+|file:\/\/[^\s"'<>\)]+)/gi;
    let m;
    while ((m = urlRegex.exec(obj)) !== null) {
      const rawUrl = m[1].replace(/[\)\.,;]+$/, '');
      if (
        rawUrl.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i) ||
        rawUrl.includes('remnote') ||
        rawUrl.includes('amazonaws.com') ||
        rawUrl.includes('user-data') ||
        rawUrl.startsWith('blob:')
      ) {
        foundUrls.add(rawUrl);
      }
    }

    const mdRegex = /!\[.*?\]\(([^\s\)]+)\)/gi;
    while ((m = mdRegex.exec(obj)) !== null) {
      if (m[1]) foundUrls.add(m[1]);
    }

    const htmlRegex = /<img[^>]+src=["']([^"']+)["']/gi;
    while ((m = htmlRegex.exec(obj)) !== null) {
      if (m[1]) foundUrls.add(m[1]);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      findImageUrlsInObject(item, foundUrls);
    }
  } else if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      try {
        const val = obj[key];
        if (key === 'url' || key === 'src' || key === 'fileUrl' || key === 'hyperlink' || key === 'path') {
          if (typeof val === 'string') {
            if (val.startsWith('http') || val.startsWith('data:image') || val.startsWith('blob:') || val.includes('%LOCAL_FILE%')) {
              foundUrls.add(val);
            }
          }
        }
        findImageUrlsInObject(val, foundUrls);
      } catch (e) {}
    }
  }
  return foundUrls;
}

async function scanRemRecursively(
  plugin: ReactRNPlugin,
  rem: any,
  foundUrls: Set<string>,
  depth = 0
) {
  if (!rem || depth > 5) return;

  findImageUrlsInObject(rem.text, foundUrls);
  findImageUrlsInObject(rem.backText, foundUrls);

  try {
    if (typeof rem.getSources === 'function') {
      const sources = await rem.getSources();
      if (sources) {
        findImageUrlsInObject(sources, foundUrls);
      }
    }
  } catch (e) {}

  let childrenRemList: any[] = [];
  if (typeof rem.getChildrenRem === 'function') {
    try {
      const c = await rem.getChildrenRem();
      if (c && Array.isArray(c)) childrenRemList = c;
    } catch (e) {}
  }

  if (childrenRemList.length === 0 && rem.children && Array.isArray(rem.children)) {
    for (const childId of rem.children) {
      try {
        const id = typeof childId === 'string' ? childId : childId?._id;
        if (id) {
          const childRem = await plugin.rem.findOne(id);
          if (childRem) childrenRemList.push(childRem);
        }
      } catch (e) {}
    }
  }

  for (const child of childrenRemList) {
    await scanRemRecursively(plugin, child, foundUrls, depth + 1);
  }
}

async function scanCardThoroughly(
  plugin: ReactRNPlugin,
  cardObj: any,
  foundUrls: Set<string>
) {
  if (!cardObj) return;

  findImageUrlsInObject(cardObj.front, foundUrls);
  findImageUrlsInObject(cardObj.back, foundUrls);

  try {
    if (typeof cardObj.getFront === 'function') {
      findImageUrlsInObject(await cardObj.getFront(), foundUrls);
    }
    if (typeof cardObj.getBack === 'function') {
      findImageUrlsInObject(await cardObj.getBack(), foundUrls);
    }
  } catch (e) {}
}

async function extractAllCardImages(
  plugin: ReactRNPlugin,
  cardObj: any,
  remObj: any
): Promise<string[]> {
  const urlsSet = new Set<string>();

  await scanCardThoroughly(plugin, cardObj, urlsSet);

  if (remObj) {
    await scanRemRecursively(plugin, remObj, urlsSet, 0);
  }

  try {
    if (plugin?.richText?.findAllExternalURLs) {
      if (cardObj?.front) (await plugin.richText.findAllExternalURLs(cardObj.front)).forEach((u: string) => urlsSet.add(u));
      if (cardObj?.back) (await plugin.richText.findAllExternalURLs(cardObj.back)).forEach((u: string) => urlsSet.add(u));
      if (remObj?.text) (await plugin.richText.findAllExternalURLs(remObj.text)).forEach((u: string) => urlsSet.add(u));
      if (remObj?.backText) (await plugin.richText.findAllExternalURLs(remObj.back)).forEach((u: string) => urlsSet.add(u));
    }
  } catch (e) {}

  const docs = getAllDocumentsOnPage();
  for (const doc of docs) {
    try {
      const imgs = Array.from(doc.querySelectorAll('img'));
      for (const img of imgs) {
        if (
          img.src &&
          !img.src.includes('avatar') &&
          !img.src.includes('icon') &&
          !img.src.includes('logo') &&
          !img.src.includes('svg')
        ) {
          const b64 = getBase64FromImageElement(img);
          if (b64) {
            urlsSet.add(b64);
          } else if (img.src.startsWith('http') || img.src.startsWith('blob:')) {
            urlsSet.add(img.src);
          }
        }
      }
    } catch (e) {}
  }

  const base64Images: string[] = [];
  for (const url of Array.from(urlsSet)) {
    const b64 = await resolveAndConvertImageToBase64(url);
    if (b64 && !base64Images.includes(b64)) {
      base64Images.push(b64);
    }
  }

  return base64Images;
}

// MARK: - 2. Text & Path Helpers

async function richTextToString(plugin: ReactRNPlugin, richText: any): Promise<string> {
  if (!richText) return '';
  if (typeof richText === 'string') return richText;

  try {
    if (plugin?.richText?.toString) {
      const res = await plugin.richText.toString(richText);
      if (res && res.trim()) return res;
    }
  } catch (e) {}

  if (Array.isArray(richText)) {
    let out = '';
    for (const item of richText) {
      if (typeof item === 'string') {
        out += item;
      } else if (item && typeof item === 'object') {
        if (typeof item.text === 'string') {
          out += item.text;
        } else if (typeof item.str === 'string') {
          out += item.str;
        } else if (item.text) {
          out += await richTextToString(plugin, item.text);
        } else if (Array.isArray(item)) {
          out += await richTextToString(plugin, item);
        }
      }
    }
    return out;
  }

  if (typeof richText === 'object') {
    if (typeof richText.text === 'string') return richText.text;
    if (typeof richText.str === 'string') return richText.str;
  }

  return String(richText || '');
}

async function getRemPath(plugin: ReactRNPlugin, rem: any): Promise<string> {
  if (!rem) return '';
  const pathTitles: string[] = [];
  const visited = new Set<string>();
  if (rem._id) visited.add(rem._id);

  let current = rem;
  let depth = 0;

  while (current && depth < 10) {
    try {
      let parentRem: any = null;

      if (typeof current.getParentRem === 'function') {
        parentRem = await current.getParentRem();
      }

      if (!parentRem && current.parent) {
        const pId = typeof current.parent === 'string' ? current.parent : current.parent?._id;
        if (pId) {
          parentRem = await plugin.rem.findOne(pId);
        }
      }

      if (!parentRem || !parentRem._id || visited.has(parentRem._id)) {
        break;
      }
      visited.add(parentRem._id);

      let parentText = await richTextToString(plugin, parentRem.text);
      parentText = parentText.replace(/\s+/g, ' ').trim();

      if (parentText) {
        pathTitles.unshift(parentText);
      }

      current = parentRem;
      depth++;
    } catch (e) {
      break;
    }
  }

  return pathTitles.join(' > ');
}

// MARK: - 3. NUMBERED LIST DETEKTOR

async function isRemNumberedListItem(
  plugin: ReactRNPlugin,
  rem: any,
  parentRem?: any,
  cardObj?: any
): Promise<boolean> {
  if (!rem) return false;

  // 1. Powerup 'i' (List) auf Rem oder Parent prüfen
  try {
    if (typeof rem.hasPowerup === 'function') {
      if ((await rem.hasPowerup(BuiltInPowerupCodes?.List || 'i')) || (await rem.hasPowerup('i'))) {
        return true;
      }
    }
    if (parentRem && typeof parentRem.hasPowerup === 'function') {
      if ((await parentRem.hasPowerup(BuiltInPowerupCodes?.List || 'i')) || (await parentRem.hasPowerup('i'))) {
        return true;
      }
    }
  } catch (e) {}

  // 2. Powerup Property 'practiceInOrder' prüfen
  try {
    if (typeof rem.getPowerupProperty === 'function') {
      const p = await rem.getPowerupProperty('i', 'practiceInOrder');
      if (p !== undefined && p !== null) return true;
    }
    if (parentRem && typeof parentRem.getPowerupProperty === 'function') {
      const p = await parentRem.getPowerupProperty('i', 'practiceInOrder');
      if (p !== undefined && p !== null) return true;
    }
  } catch (e) {}

  // 3. Tag-Rems auflösen
  try {
    const tagsToCheck = [
      ...(typeof rem.getTagRems === 'function' ? (await rem.getTagRems()) || [] : []),
      ...(parentRem && typeof parentRem.getTagRems === 'function' ? (await parentRem.getTagRems()) || [] : [])
    ];
    for (const t of tagsToCheck) {
      if (t._id === 'i' || (t as any).code === 'i') return true;
      const title = (await richTextToString(plugin, t.text)).toLowerCase();
      if (title.includes('list') || title.includes('aufzählung') || title.includes('liste') || title.includes('numbered')) {
        return true;
      }
    }
  } catch (e) {}

  // 4. taggedRem() des List-Powerups prüfen
  try {
    const listPowerup = await plugin.powerup.getPowerupByCode(BuiltInPowerupCodes?.List || 'i');
    if (listPowerup) {
      const tagged = await listPowerup.taggedRem();
      const ids = new Set(tagged.map((r: any) => r._id));
      if (ids.has(rem._id) || (parentRem && ids.has(parentRem._id))) {
        return true;
      }
    }
  } catch (e) {}

  // 5. Direkte Eigenschaften prüfen
  if (rem.listType === 'numbered' || rem.listType === 'numeric' || rem.listType === 'ordered') return true;
  if (rem.isNumbered === true || rem.isOrdered === true) return true;
  if (parentRem) {
    if (parentRem.listType === 'numbered' || parentRem.listType === 'numeric' || parentRem.listType === 'ordered') return true;
    if (parentRem.isNumbered === true || parentRem.isOrdered === true) return true;
  }

  // 6. Card-Eigenschaften
  if (cardObj) {
    if (cardObj.isListCard || cardObj.listType === 'numbered' || (cardObj as any).cardType === 'list') {
      return true;
    }
  }

  return false;
}

// MARK: - 4. HIERARCHIE FORMATIERUNG (Hauptpunkte nummeriert, Unterpunkte mit Bullet)

async function formatRemHierarchy(
  plugin: ReactRNPlugin,
  parentRem: any,
  indent = 0,
  cardObj?: any
): Promise<string[]> {
  if (!parentRem) return [];
  const lines: string[] = [];

  let childrenRemList: any[] = [];
  if (typeof parentRem.getChildrenRem === 'function') {
    try {
      const c = await parentRem.getChildrenRem();
      if (c && Array.isArray(c)) childrenRemList = c;
    } catch (e) {}
  }

  if (childrenRemList.length === 0 && parentRem.children && Array.isArray(parentRem.children)) {
    for (const childId of parentRem.children) {
      try {
        const id = typeof childId === 'string' ? childId : childId?._id;
        if (id) {
          const childRem = await plugin.rem.findOne(id);
          if (childRem) childrenRemList.push(childRem);
        }
      } catch (e) {}
    }
  }

  if (childrenRemList.length === 0) return [];

  // Nur auf Top-Level (indent === 0) prüfen wir, ob die Hauptliste nummeriert ist
  let isNumbered = false;
  if (indent === 0) {
    isNumbered = await isRemNumberedListItem(plugin, parentRem, undefined, cardObj);
    if (!isNumbered) {
      for (const child of childrenRemList) {
        if (await isRemNumberedListItem(plugin, child, parentRem, cardObj)) {
          isNumbered = true;
          break;
        }
      }
    }
    if (!isNumbered && childrenRemList.length > 0) {
      const firstText = (await richTextToString(plugin, childrenRemList[0].text)).trim();
      if (/^\d+[\.\)]\s/.test(firstText)) {
        isNumbered = true;
      }
    }
  } else {
    // Unterpunkte (indent > 0) erhalten immer Bullets, außer sie sind selbst explizit nummeriert
    if (parentRem.listType === 'numbered' || parentRem.isNumbered === true) {
      isNumbered = true;
    }
  }

  for (let i = 0; i < childrenRemList.length; i++) {
    const childRem = childrenRemList[i];
    let rawText = (await richTextToString(plugin, childRem.text)).trim();
    if (!rawText && childRem.backText) {
      rawText = (await richTextToString(plugin, childRem.backText)).trim();
    }

    if (rawText) {
      const indentSpaces = '  '.repeat(indent);
      let cleanText = rawText;
      let prefix = '';

      // Text von eventuell manuell vorangestellten Bullets/Nummern bereinigen
      if (/^\d+[\.\)]\s+/.test(cleanText)) {
        cleanText = cleanText.replace(/^\d+[\.\)]\s+/, '');
        prefix = (indent === 0 && isNumbered) ? `${indentSpaces}${i + 1}. ` : `${indentSpaces}• `;
      } else if (/^[\u2022\-\*]\s+/.test(cleanText)) {
        cleanText = cleanText.replace(/^[\u2022\-\*]\s+/, '');
        prefix = (indent === 0 && isNumbered) ? `${indentSpaces}${i + 1}. ` : `${indentSpaces}• `;
      } else {
        prefix = (indent === 0 && isNumbered) ? `${indentSpaces}${i + 1}. ` : `${indentSpaces}• `;
      }

      lines.push(`${prefix}${cleanText}`);
    }

    // Rekursiver Aufruf für tiefere Ebenen (indent + 1 -> immer mit Bullets)
    const subLines = await formatRemHierarchy(plugin, childRem, indent + 1, cardObj);
    lines.push(...subLines);
  }

  return lines;
}

// MARK: - 5. ZENTRALE EXTRAKTION FÜR ALLE KARTENTYPEN

async function extractCardData(
  plugin: ReactRNPlugin,
  cardObj: any,
  remObj: any
): Promise<{ front: string; back: string }> {
  // 1. Vorderseite ermitteln
  let frontText = '';
  if (cardObj && typeof cardObj.getFront === 'function') {
    try {
      frontText = await richTextToString(plugin, await cardObj.getFront());
    } catch (e) {}
  }
  if (!frontText.trim() && cardObj?.front) {
    frontText = await richTextToString(plugin, cardObj.front);
  }
  if (!frontText.trim() && remObj?.text) {
    frontText = await richTextToString(plugin, remObj.text);
  }

  // 2. Direkte Rückseite (für Single-Line Karten "iebf :: Antwort")
  let directBackText = '';
  if (cardObj && typeof cardObj.getBack === 'function') {
    try {
      directBackText = await richTextToString(plugin, await cardObj.getBack());
    } catch (e) {}
  }
  if (!directBackText.trim() && cardObj?.back) {
    directBackText = await richTextToString(plugin, cardObj.back);
  }
  if (!directBackText.trim() && remObj?.backText) {
    directBackText = await richTextToString(plugin, remObj.backText);
  }

  // 3. Untergeordnete Kinder prüfen (für Multi-Line & List-Answer Karten)
  let childrenList: any[] = [];
  if (remObj && typeof remObj.getChildrenRem === 'function') {
    try {
      childrenList = (await remObj.getChildrenRem()) || [];
    } catch (e) {}
  }
  if (childrenList.length === 0 && remObj?.children && Array.isArray(remObj.children)) {
    for (const cid of remObj.children) {
      const id = typeof cid === 'string' ? cid : cid?._id;
      if (id) {
        const c = await plugin.rem.findOne(id);
        if (c) childrenList.push(c);
      }
    }
  }

  // Fall A: Multi-Line oder List-Answer Karte (hat Unterpunkte)
  if (childrenList.length > 0) {
    const formattedChildren = (await formatRemHierarchy(plugin, remObj, 0, cardObj)).join('\n');

    if (directBackText.trim() && !formattedChildren.includes(directBackText.trim())) {
      return {
        front: frontText.trim(),
        back: `${directBackText.trim()}\n${formattedChildren}`.trim(),
      };
    }

    return {
      front: frontText.trim(),
      back: formattedChildren.trim(),
    };
  }

  // Fall B: Normale Single-Line Karte (Frage :: Antwort)
  return {
    front: frontText.trim(),
    back: directBackText.trim(),
  };
}

// MARK: - 6. LIVE-SYNC ZUR SWIFT APP

async function syncCurrentCard(plugin: ReactRNPlugin) {
  if (isSyncing) return;
  isSyncing = true;

  try {
    if (!plugin.queue) return;

    const queueCard = await plugin.queue.getCurrentCard();
    const cardId = queueCard?._id || (queueCard as any)?.id || null;

    if (!cardId) return;

    const cardObj = await plugin.card.findOne(cardId);
    if (!cardObj) return;

    let remObj = typeof cardObj.getRem === 'function' ? await cardObj.getRem() : null;
    if (!remObj) {
      const remId = cardObj.remId || (cardObj as any).rem;
      remObj = remId ? await plugin.rem.findOne(remId) : null;
    }

    const pngImages = await extractAllCardImages(plugin, cardObj, remObj);

    let pathText = '';
    if (remObj) {
      try {
        pathText = await getRemPath(plugin, remObj);
      } catch (e) {}
    }

    const { front, back } = await extractCardData(plugin, cardObj, remObj);

    const currentKey = cardId + '_' + pngImages.length + '_' + pathText + '_' + front + '_' + back;
    if (lastSentCardId === currentKey) return;

    lastSentCardId = currentKey;

    const payload = {
      cardId,
      remId: remObj?._id || cardId,
      front: front,
      back: back,
      path: pathText,
      images: pngImages,
      timestamp: Date.now(),
    };

    await fetch(DESTINATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('🔴 [Auto-Sync] Verbindungsfehler zu Swift:', error);
  } finally {
    isSyncing = false;
  }
}

// MARK: - 7. PLUGIN LIFECYCLE

export async function onActivate(plugin: ReactRNPlugin) {
  console.log('🟢 [RemNote Exporter] Sync aktiv!');

  try {
    plugin.event.addListener('queue.load-card', 'auto-sync-load', () => {
      syncCurrentCard(plugin);
    });

    plugin.event.addListener('queue.reveal-answer', 'auto-sync-reveal', () => {
      syncCurrentCard(plugin);
    });
  } catch (e) {
    console.error('Event Listener Fehler:', e);
  }

  setInterval(() => {
    syncCurrentCard(plugin);
  }, 1000);
}

export async function onDeactivate(plugin: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);