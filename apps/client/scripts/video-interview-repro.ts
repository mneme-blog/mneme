// Regression check for the guided video interview: the question-plan parser
// survives the ways a model actually misbehaves, the videoInterview node mounts
// and renders its questions, and the doc helpers surface the question text
// (previews/search) and EXACTLY the media ids the node references (deletion +
// phrase rotation). The camera, the codecs, and the title-card canvas are
// verified manually — jsdom has none of them.
// Run: pnpm --filter client exec tsx scripts/video-interview-repro.ts
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
  pretendToBeVisual: true,
  // An explicit origin — jsdom refuses localStorage on the default opaque one,
  // and the capture-quality check reads it.
  url: 'https://localhost/',
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so a plain assignment
// throws. defineProperty replaces it outright.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
g.localStorage = dom.window.localStorage;
g.MutationObserver = dom.window.MutationObserver;
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.Document = dom.window.Document;
g.DOMParser = dom.window.DOMParser;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.CustomEvent = dom.window.CustomEvent;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.ShadowRoot = dom.window.ShadowRoot;
g.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
g.IntersectionObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
(dom.window.Document.prototype as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function main(): Promise<void> {
  const { Editor } = await import('@tiptap/core');
  const { buildExtensions, docToText, docMediaIds } = await import('../src/editor/doc');
  const { videoInterviewNode } = await import('../src/editor/videointerview');
  const {
    coerceVideoInterview,
    videoInterviewMediaIds,
    setFilmAttr,
    isAnswered,
    isFilmStale,
    buildVideoInterviewDoc,
  } = await import('../src/editor/videointerviewData');
  type MediaAttachment = import('../src/sync/engine').MediaAttachment;

  const clip = (id: string, createdAt: number): MediaAttachment => ({
    id,
    kind: 'video',
    mime: 'video/webm',
    bytes: 1_000_000,
    durationMs: 42_000,
    createdAt,
  });

  const clip1 = clip('clip-one', 100);
  const clip2 = clip('clip-two', 200);
  const film: MediaAttachment = { ...clip('film-id', 300), name: 'film' };

  const attrs = {
    sessionId: 'session-abc',
    typeName: 'Daily reflection',
    cards: [
      { q: 'What stood out today?', clip: clip1 },
      { q: 'What did you avoid?', clip: null, dropped: true },
      { q: 'What are you carrying into tomorrow?', clip: clip2 },
    ],
    film,
    renderedAt: 400,
  };

  // ── plan parsing: the shapes a real model returns ──
  const { parseQuestionPlan, toPlan, PLAN_MAX } = await import('../src/ai/plan');

  const cleanQ = 'Q: What stood out today?\nQ: What did you avoid?\nQ: What is next?';
  assert(
    same(parseQuestionPlan(cleanQ), ['What stood out today?', 'What did you avoid?', 'What is next?']),
    'clean "Q:" lines parse verbatim',
  );

  const numbered = '1. What stood out today?\n2) What did you avoid?\n3. What is next?';
  assert(parseQuestionPlan(numbered).length === 3, 'numbered lines parse');
  assert(parseQuestionPlan(numbered)[1] === 'What did you avoid?', 'numbering is stripped');

  const bulleted = '- What stood out today?\n* What did you avoid?\n• What is next?';
  assert(parseQuestionPlan(bulleted).length === 3, 'bulleted lines parse');
  assert(parseQuestionPlan(bulleted)[2] === 'What is next?', 'bullet markers are stripped');

  const chatty =
    "Sure! Here are the questions I'd ask:\n\nQ: What stood out today?\nQ: What did you avoid?\nQ: What is next?\n\nLet me know if you want more.";
  assert(
    same(parseQuestionPlan(chatty), ['What stood out today?', 'What did you avoid?', 'What is next?']),
    'a chatty preamble around "Q:" lines is discarded',
  );

  const quoted = '"What stood out today?"\n«What did you avoid?»\n“What is next?”';
  assert(parseQuestionPlan(quoted).length === 3, 'quoted lines parse');
  assert(parseQuestionPlan(quoted)[0] === 'What stood out today?', 'wrapping quotes are stripped');

  const dupes = 'Q: What stood out today?\nQ: what stood out today?\nQ: What did you avoid?';
  assert(parseQuestionPlan(dupes).length === 2, 'case-insensitive duplicates collapse');

  const rant = `Q: ${'a'.repeat(900)}?\nQ: What stood out today?\nQ: hi`;
  const ranted = parseQuestionPlan(rant);
  assert(!ranted.some((q) => q.length > 240), 'over-long lines are dropped');
  assert(!ranted.includes('hi'), 'too-short lines are dropped');

  const many = Array.from({ length: 14 }, (_, i) => `Q: Question number ${i + 1} about your day?`).join('\n');
  assert(parseQuestionPlan(many).length === PLAN_MAX, `the plan is clamped to ${PLAN_MAX}`);

  // Both of these were found against a real local model, not by inspection.
  // A chatty model appends a remark after the question mark — the line is still
  // a question, so an endsWith('?') filter would wrongly drop it.
  const trailing =
    'Q: What stood out today?\nQ: What did you avoid?\nQ: What made you smile? Share the details!\nQ: What is next?';
  assert(
    parseQuestionPlan(trailing).includes('What made you smile? Share the details!'),
    'a question with a trailing remark after the "?" survives',
  );
  // The token limit can cut the last line off mid-sentence; it has no question
  // mark, so the same filter discards it.
  const truncated =
    'Q: What stood out today?\nQ: What did you avoid?\nQ: What is next?\nQ: As we approach tomorrow, is there';
  assert(
    !parseQuestionPlan(truncated).some((q) => q.startsWith('As we approach tomorrow')),
    'a final line the token limit truncated is dropped',
  );

  assert(toPlan(cleanQ).fallback === false, 'a good plan is not a fallback');
  assert(toPlan('').fallback === true, 'an empty response falls back');
  assert(toPlan('').questions.length >= 3, 'the fallback set has usable questions');
  assert(toPlan('[]').fallback === true, 'a JSON array response falls back');
  assert(toPlan('I cannot help with that.').fallback === true, 'a refusal falls back');
  console.log('ok: question-plan parsing (11 model failure modes + fallback)');

  // ── coercion survives malformed attrs ──
  assert(coerceVideoInterview({ cards: 'nope' }) === null, 'a non-array cards attr yields null');
  assert(coerceVideoInterview({}) === null, 'missing attrs yield null');
  assert(coerceVideoInterview({ cards: [] }) === null, 'an empty session yields null');
  const junk = coerceVideoInterview({ cards: [{ q: 1, clip: 'x' }, null] });
  assert(junk !== null && junk.cards.length === 2, 'junk entries still produce cards');
  assert(junk.cards[0].q === '' && junk.cards[0].clip === null, 'a non-string question and non-object clip coerce safely');
  assert(coerceVideoInterview({ cards: [{ q: 'a', clip: { id: '' } }] })?.cards[0].clip === null, 'an id-less clip coerces to null');
  const round = coerceVideoInterview(JSON.parse(JSON.stringify(attrs)) as Record<string, unknown>);
  assert(round !== null && round.cards.length === 3 && round.film?.id === 'film-id', 'a real session round-trips through JSON');
  console.log('ok: coerceVideoInterview survives malformed attrs');

  // ── answered-ness survives "Delete the source clips" ──
  const droppedCards = coerceVideoInterview({
    cards: [
      { q: 'kept', clip: clip1 },
      { q: 'dropped', clip: null, dropped: true },
      { q: 'transcribed then dropped (pre-flag doc)', clip: null, transcript: 'what was said' },
      { q: 'skipped', clip: null },
      { q: 'junk flag', clip: null, dropped: 'yes' },
    ],
  });
  assert(droppedCards !== null, 'dropped cards coerce');
  assert(droppedCards.cards[1].dropped === true, 'the dropped flag round-trips');
  assert(droppedCards.cards[4].dropped === undefined, 'a non-boolean dropped flag coerces away');
  assert(isAnswered(droppedCards.cards[0]), 'a card with its clip is answered');
  assert(isAnswered(droppedCards.cards[1]), 'a card whose source clip was dropped is STILL answered');
  assert(isAnswered(droppedCards.cards[2]), 'a transcript alone marks a pre-flag card as answered');
  assert(!isAnswered(droppedCards.cards[3]), 'a skipped card is not answered');
  assert(droppedCards.cards.filter(isAnswered).length === 3, 'the header count survives a clip cleanup');
  console.log('ok: isAnswered + dropped flag (clip cleanup does not zero the count)');

  // ── the media-id walk, on raw attrs ──
  assert(
    same(videoInterviewMediaIds(attrs as unknown as Record<string, unknown>), ['clip-one', 'clip-two', 'film-id']),
    'videoInterviewMediaIds returns clips then the film',
  );
  assert(same(videoInterviewMediaIds({ cards: [] }), []), 'an empty session references no media');
  assert(same(videoInterviewMediaIds({ cards: [{ q: 'a', clip: clip1 }], film: null }), ['clip-one']), 'a film-less session counts only its clips');
  console.log('ok: videoInterviewMediaIds');

  // ── node mounts + renders the questions ──
  const removed: string[] = [];
  const editor = new Editor({
    element: document.getElementById('mount') as HTMLElement,
    extensions: [
      ...buildExtensions('placeholder'),
      videoInterviewNode({ resolve: async () => null, onRemoved: (a) => removed.push(a.id) }),
    ],
    content: { type: 'doc', content: [{ type: 'videoInterview', attrs }, { type: 'paragraph' }] },
  });
  await new Promise((r) => setTimeout(r, 0));
  const card = document.querySelector('.mneme-video-interview-node');
  assert(card, 'videoInterview node view renders');
  assert(card.textContent?.includes('Daily reflection'), 'the card shows the interview type name');
  assert(card.textContent?.includes('What stood out today?'), 'the card shows the first question');
  assert(card.textContent?.includes('What are you carrying into tomorrow?'), 'the card shows the last question');
  assert(card.textContent?.includes('3 of 3 answered'), 'the header counts a dropped-clip answer as answered');
  assert(card.textContent?.includes('Answered — source clip deleted'), 'a dropped-clip card explains itself');
  assert(!card.textContent?.includes('Not recorded'), 'a dropped-clip card does not read as skipped');
  console.log('ok: videoInterview node mounts and renders its questions');

  // ── doc helpers ──
  const json = editor.getJSON();
  const text = docToText(json);
  assert(text.includes('🎬 Daily reflection'), `docToText surfaces the type name (got "${text.slice(0, 80)}")`);
  for (const q of attrs.cards.map((c) => c.q)) {
    assert(text.includes(q), `docToText surfaces the question "${q}" — the answers are video, so this is all search has`);
  }

  // THE security-relevant assertion: an exact match, not a superset. A nested
  // media reference added without updating the walk fails here rather than
  // silently outliving the entry on the relay.
  const ids = docMediaIds(json);
  assert(
    same(ids, ['clip-one', 'clip-two', 'film-id']),
    `docMediaIds returns EXACTLY the session's clips + film (got [${ids.join(', ')}])`,
  );
  console.log(`ok: docToText + docMediaIds (exactly ${ids.length} media ids)`);

  // ── staleness + the out-of-editor film write-back ──
  const data = coerceVideoInterview(attrs as unknown as Record<string, unknown>);
  assert(data !== null, 'session data coerces');
  assert(isFilmStale(data) === false, 'a film rendered after every clip is fresh');
  assert(isFilmStale({ ...data, renderedAt: 150 }) === true, 'a clip newer than the render makes the film stale');
  assert(isFilmStale({ ...data, film: null, renderedAt: null }) === false, 'no film is never stale');

  const twoNodes = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'videoInterview', attrs: { ...attrs, sessionId: 'session-abc', film: null, renderedAt: null } },
      { type: 'videoInterview', attrs: { ...attrs, sessionId: 'other-session', film: null, renderedAt: null } },
    ],
  });
  const patched = setFilmAttr(twoNodes, 'session-abc', film, 999);
  assert(patched !== null, 'setFilmAttr patches a matching session');
  const parsed = JSON.parse(patched) as { content: { attrs: Record<string, unknown> }[] };
  assert((parsed.content[0].attrs.film as { id: string }).id === 'film-id', 'the addressed node got the film');
  assert(parsed.content[0].attrs.renderedAt === 999, 'the addressed node got the render time');
  assert(parsed.content[1].attrs.film === null, 'the other session is untouched');
  assert(setFilmAttr(twoNodes, 'no-such-session', film, 1) === null, 'an unknown sessionId returns null');
  assert(setFilmAttr('not json', 'session-abc', film, 1) === null, 'an unparseable body returns null');
  assert(setFilmAttr(undefined, 'session-abc', film, 1) === null, 'a missing body returns null');
  console.log('ok: isFilmStale + setFilmAttr (addressed by sessionId)');

  // ── the doc the session sheet saves ──
  const built = buildVideoInterviewDoc(data);
  assert(built.content?.[0].type === 'videoInterview', 'buildVideoInterviewDoc leads with the node');
  assert(built.content?.[1].type === 'paragraph', 'a trailing paragraph parks the cursor after the atom');
  assert(same(docMediaIds(built), ['clip-one', 'clip-two', 'film-id']), 'the built doc reports the same media ids');
  console.log('ok: buildVideoInterviewDoc');

  // ── capture quality: constraints stay soft, bitrate is actually capped ──
  const { cameraConstraints, recorderOptions, videoQuality, setVideoQuality, VIDEO_QUALITY } =
    await import('../src/ui/recorder');
  localStorage.removeItem('mneme.video.quality');
  assert(videoQuality() === 'medium', 'an unset quality defaults to 720p');
  localStorage.setItem('mneme.video.quality', 'ultra');
  assert(videoQuality() === 'medium', 'an unknown stored quality falls back to the default');
  for (const level of ['low', 'medium', 'high'] as const) {
    setVideoQuality(level);
    assert(videoQuality() === level, `${level} round-trips through localStorage`);
    const video = cameraConstraints().video as MediaTrackConstraints;
    // `exact` here would mean OverconstrainedError — no camera at all — on any
    // device without the requested mode. Every constraint must stay `ideal`.
    assert(JSON.stringify(video).includes('exact') === false, `${level} constrains with ideal, never exact`);
    assert((video.width as { ideal: number }).ideal === VIDEO_QUALITY[level].width, `${level} asks for its frame width`);
    assert((video.height as { ideal: number }).ideal === VIDEO_QUALITY[level].height, `${level} asks for its frame height`);
    assert(video.facingMode === 'user', `${level} still selects the front camera`);
    assert(
      recorderOptions('video/webm').videoBitsPerSecond === VIDEO_QUALITY[level].bitsPerSecond,
      `${level} caps the recorder bitrate (the browser default ~2.5 Mbps ignores frame size)`,
    );
    assert(recorderOptions('video/webm').mimeType === 'video/webm', `${level} keeps the chosen container`);
    assert(!('mimeType' in recorderOptions(undefined)), 'an unsupported format leaves mimeType to the browser');
  }
  assert(
    VIDEO_QUALITY.low.bitsPerSecond < VIDEO_QUALITY.medium.bitsPerSecond &&
      VIDEO_QUALITY.medium.bitsPerSecond < VIDEO_QUALITY.high.bitsPerSecond,
    'the levels are ordered by bitrate',
  );
  localStorage.removeItem('mneme.video.quality');
  console.log('ok: capture quality (defaults, ideal-only constraints, bitrate cap)');

  // ── the on-camera countdown rounds UP ──
  // A nearest-rounding countdown parks on 0:00 for the last half second while
  // the camera is still rolling, which reads as a frozen timer. 0:00 must mean
  // the recorder has stopped, nothing else.
  const { fmtCountdown, fmtDuration, answerLimitSeconds, setAnswerLimitSeconds } = await import('../src/ui/recorder');
  assert(fmtCountdown(90_000) === '1:30', 'a full 90 s answer starts at 1:30');
  assert(fmtCountdown(400) === '0:01', '0.4 s left still shows a second, not 0:00');
  assert(fmtDuration(400) === '0:00', 'the elapsed clock keeps rounding to nearest');
  assert(fmtCountdown(0) === '0:00', 'the limit reached shows 0:00');
  assert(fmtCountdown(-500) === '0:00', 'an overshooting tick never shows negative time');
  assert(fmtCountdown(61_000) === '1:01', 'minutes and seconds are zero-padded');
  // The chip counts down against this limit, so an out-of-range stored value
  // must not silently make the bar or the clock nonsensical.
  localStorage.setItem('mneme.videoInterview.maxSeconds', '9000');
  assert(answerLimitSeconds() === 90, 'an out-of-range stored limit falls back to the default');
  setAnswerLimitSeconds(30);
  assert(answerLimitSeconds() === 30, 'a chosen limit round-trips through localStorage');
  localStorage.removeItem('mneme.videoInterview.maxSeconds');
  console.log('ok: answer countdown (rounds up, clamps at zero, limit fallback)');

  // ── timeline: whole frames, no drift across segments ──
  const { planTimeline, estimateSeconds, CARD_SECONDS, FILM_FPS: FPS } = await import('../src/video/timeline');
  const durations = [42.0, 17.5, 63.2, 8.4, 91.9];
  const tl = planTimeline(durations, FPS, CARD_SECONDS);
  assert(tl.segments.length === durations.length * 2, 'one card and one clip per question');
  assert(tl.segments[0].kind === 'card' && tl.segments[1].kind === 'clip', 'each question leads with its card');
  assert(Number.isInteger(tl.totalFrames), 'the total is a whole number of frames');
  assert(tl.segments.every((s) => Number.isInteger(s.frames) && s.frames > 0), 'every segment is a positive whole number of frames');
  // Contiguous and monotonic: segment N starts exactly where N-1 ended, to the
  // frame. This is the property that keeps a six-question film in sync.
  let cursor = 0;
  for (const s of tl.segments) {
    assert(Math.abs(s.startS - cursor / FPS) < 1e-9, `segment ${s.kind}/${s.index} starts exactly where the previous ended`);
    cursor += s.frames;
  }
  assert(cursor === tl.totalFrames, 'the segments account for every frame');
  const expected = estimateSeconds(durations, CARD_SECONDS);
  assert(Math.abs(tl.totalS - expected) < 1 / FPS, `total ≈ clips + cards (${tl.totalS.toFixed(3)} vs ${expected.toFixed(3)})`);
  assert(planTimeline([0], FPS, CARD_SECONDS).segments[1].frames >= 1, 'a zero-length take still contributes a frame');
  assert(planTimeline([], FPS, CARD_SECONDS).totalFrames === 0, 'no clips means no film');
  console.log(`ok: planTimeline (${tl.segments.length} segments, ${tl.totalFrames} frames, contiguous)`);

  // ── audio normalization ──
  const { downmixToMono, resampleLinear, silence, fitLength, chunkFrames } = await import('../src/video/audiomix');

  const left = Float32Array.from([1, 1, 1, 1]);
  const right = Float32Array.from([-1, -1, -1, -1]);
  assert(Array.from(downmixToMono([left, right])).every((x) => x === 0), 'L=+1 / R=-1 downmixes to silence');
  assert(downmixToMono([left]) === left, 'a mono source passes through untouched');
  assert(downmixToMono([]).length === 0, 'no channels yields nothing');

  // A 44.1 kHz ramp resampled to 48 kHz: the standard iOS → output conversion.
  const ramp = Float32Array.from({ length: 441 }, (_, i) => i / 440);
  const up = resampleLinear(ramp, 44100, 48000);
  assert(Math.abs(up.length - 480) <= 1, `48 kHz run is ~480 samples (got ${up.length})`);
  assert(up[0] === ramp[0], 'the first sample is preserved exactly');
  assert(Math.abs(up[up.length - 1] - 1) < 0.01, 'the last sample lands on the ramp end');
  let monotonic = true;
  for (let i = 1; i < up.length; i++) if (up[i] < up[i - 1] - 1e-6) monotonic = false;
  assert(monotonic, 'a monotonic ramp stays monotonic through resampling');
  assert(resampleLinear(ramp, 48000, 48000) === ramp, 'a matching rate is a no-op');
  const down = resampleLinear(ramp, 48000, 44100);
  assert(down.length < ramp.length, 'downsampling shortens the run');

  assert(silence(1200).length === 1200 && silence(1200).every((x) => x === 0), 'silence is the requested length and actually silent');
  assert(fitLength(ramp, 100).length === 100, 'an over-long run is cut to length');
  assert(fitLength(ramp, 900).length === 900, 'a short run is padded to length');
  assert(fitLength(ramp, 900)[500] === 0, 'the padding is silence');
  assert(chunkFrames(50_000, 24_000).reduce((a, b) => a + b, 0) === 50_000, 'chunking preserves the total');
  assert(chunkFrames(50_000, 24_000).every((n) => n <= 24_000), 'no chunk exceeds the cap');
  console.log('ok: audiomix (downmix, 44.1→48 kHz resample, silence, fit, chunk)');

  editor.destroy();
  console.log('\nall video-interview checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
