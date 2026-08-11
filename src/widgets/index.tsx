import { declareIndexPlugin, ReactRNPlugin } from '@remnote/plugin-sdk';

const DESTINATION_URL = 'http://127.0.0.1:8000';
let lastSentCardId: string | null = null;

/**
 * Hilfsfunktion: Konvertiert RemNote RichText sicher in einfachen Text
 */
async function richTextToString(plugin: ReactRNPlugin, richText: any): Promise<string> {
  if (!richText) return '';
  if (typeof richText === 'string') return richText;
  try {
    // Richtige SDK-Funktion: plugin.richText.toString(...)
    if (plugin.richText && typeof plugin.richText.toString === 'function') {
      return await plugin.richText.toString(richText);
    }
  } catch (e) {}
  
  // Fallback, falls der Text ein Array aus Zeichenketten/Objekten ist
  if (Array.isArray(richText)) {
    return richText.map((item: any) => (typeof item === 'string' ? item : item?.text || '')).join('');
  }
  return String(richText);
}

/**
 * Liest die aktuelle Karteikarte aus und sendet sie automatisch an Swift
 */
async function syncCurrentCard(plugin: ReactRNPlugin) {
  try {
    if (!plugin.queue) return;

    // Aktuelle Karteikarte aus der Queue abfragen
    const queueCard = await plugin.queue.getCurrentCard();
    const cardId = queueCard?._id || (queueCard as any)?.id || null;

    if (!cardId) return;

    // Verhindert mehrfaches Senden derselben Karte
    if (lastSentCardId === cardId) return;

    const cardObj = await plugin.card.findOne(cardId);
    if (!cardObj) return;

    const remId = cardObj.remId || (cardObj as any).rem;
    const remObj = remId ? await plugin.rem.findOne(remId) : null;

    const frontRich = (cardObj.front && cardObj.front.length > 0) ? cardObj.front : remObj?.text;
    const backRich = (cardObj.back && cardObj.back.length > 0) ? cardObj.back : remObj?.backText;

    // Sicheres Auslesen der Texte
    const frontText = await richTextToString(plugin, frontRich);
    const backText = await richTextToString(plugin, backRich);

    // ID merken
    lastSentCardId = cardId;

    const payload = {
      cardId,
      remId: remId || cardId,
      front: frontText,
      back: backText,
      timestamp: Date.now(),
    };

    console.log('📤 [Auto-Sync] Sende Karteikarte an Swift:', payload);

    const response = await fetch(DESTINATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log('🎉 [Auto-Sync] Erfolgreich an Swift gesendet:', frontText);
      await plugin.app.toast(`🚀 An Swift gesendet: ${frontText.substring(0, 25)}...`);
    } else {
      console.error('🔴 Server Fehler:', response.status);
    }
  } catch (error) {
    console.error('🔴 [Auto-Sync] Verbindungsfehler zu Swift:', error);
  }
}

export async function onActivate(plugin: ReactRNPlugin) {
  console.log('🟢 [RemNote Exporter] Lautloser Hintergrund-Sync gestartet!');

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

  // Regelmäßige Prüfung im Hintergrund (alle 1 Sekunde)
  setInterval(() => {
    syncCurrentCard(plugin);
  }, 1000);
}

export async function onDeactivate(plugin: ReactRNPlugin) {}

declareIndexPlugin(onActivate, onDeactivate);