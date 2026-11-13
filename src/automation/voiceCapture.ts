/**
 * Browser-context voice capture bridge.
 *
 * Instagram records voice notes through `navigator.mediaDevices.getUserMedia`
 * and `MediaRecorder`. Chromium's fake audio device produces a looping beep,
 * so a late `getUserMedia` override is unreliable: Instagram may already have
 * captured the native function or media stream. This initializer runs before
 * page scripts, substitutes the microphone stream with an AudioContext
 * destination, and also wraps `MediaRecorder` so the native fake-mic stream can
 * never be recorded by accident.
 *
 * The function is intentionally self-contained: Playwright serialises it with
 * `context.addInitScript()` / `page.evaluate()`.
 */
export function voiceCaptureInit(): void {
  const w = window as any;
  if (w.__auroicVoice && w.__auroicVoice.version >= 2) return;

  const AudioContextCtor = w.AudioContext || w.webkitAudioContext;
  if (!AudioContextCtor) return;

  const state: any = {
    version: 2,
    context: null,
    destination: null,
    analyser: null,
    analyserData: null,
    source: null,
    pendingBuffer: null,
    chunks: 0,
    lastChunkSize: 0,
    recordingStreamId: null,
    captureStreamId: null,
    captureRequests: 0,
    destinationStreamId: null,
    recorderState: null,
    peak: 0,
    sampleTimer: null,
  };

  function ensureContext(): { context: any; destination: any } {
    if (!state.context || state.context.state === "closed") {
      state.context = new AudioContextCtor();
      state.destination = state.context.createMediaStreamDestination();
      state.destinationStreamId = state.destination.stream.id;
      state.analyser = state.context.createAnalyser();
      state.analyser.fftSize = 2048;
      state.analyserData = new Float32Array(state.analyser.fftSize);
    }
    return { context: state.context, destination: state.destination };
  }

  function samplePeak(): void {
    if (!state.analyser || !state.analyserData) return;
    state.analyser.getFloatTimeDomainData(state.analyserData);
    let peak = 0;
    for (let i = 0; i < state.analyserData.length; i++) {
      const value = Math.abs(state.analyserData[i]);
      if (value > peak) peak = value;
    }
    if (peak > state.peak) state.peak = peak;
  }

  function stopSampling(): void {
    if (state.sampleTimer) {
      clearInterval(state.sampleTimer);
      state.sampleTimer = null;
    }
  }

  async function resume(): Promise<any> {
    const { context } = ensureContext();
    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }
    return context;
  }

  async function ensure() {
    const context = await resume();
    return {
      state: context.state,
      currentTime: context.currentTime,
      destinationStreamId: state.destinationStreamId,
    };
  }

  // Override microphone capture as early as possible. Keep the original for
  // non-audio requests (there should be none in this application).
  if (navigator.mediaDevices) {
    const originalGetUserMedia =
      w.__auroicOriginalGetUserMedia ||
      navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);
    w.__auroicOriginalGetUserMedia = originalGetUserMedia;

    navigator.mediaDevices.getUserMedia = async (constraints: any) => {
      if (constraints?.audio && !constraints?.video) {
        const { destination } = ensureContext();
        await resume();
        state.captureRequests += 1;
        state.captureStreamId = destination.stream.id;
        return destination.stream;
      }
      if (originalGetUserMedia) return originalGetUserMedia(constraints);
      throw new Error("getUserMedia is unavailable");
    };
  }

  // Wrap MediaRecorder as a second line of defence. Even if Instagram holds a
  // reference to the native constructor, every recorder created after this
  // script runs receives the AudioContext destination stream.
  const OriginalRecorder = w.__auroicOriginalMediaRecorder || w.MediaRecorder;
  if (OriginalRecorder && !w.__auroicOriginalMediaRecorder) {
    w.__auroicOriginalMediaRecorder = OriginalRecorder;

    function AuroicMediaRecorder(this: any, stream: any, options?: any) {
      let recordingStream = stream;
      try {
        const hasAudio = Boolean(stream?.getAudioTracks?.().length);
        const hasVideo = Boolean(stream?.getVideoTracks?.().length);
        if (hasAudio && !hasVideo) {
          recordingStream = ensureContext().destination.stream;
        }
      } catch {
        // Keep the original stream if inspection fails.
      }

      const recorder = new OriginalRecorder(recordingStream, options);
      state.recordingStreamId = recordingStream?.id ?? null;
      state.recorderState = "inactive";
      state.chunks = 0;
      state.lastChunkSize = 0;

      recorder.addEventListener("dataavailable", (event: any) => {
        const size = event?.data?.size ?? 0;
        state.chunks += size;
        state.lastChunkSize = size;
      });
      recorder.addEventListener("start", () => {
        state.recorderState = "recording";
      });
      recorder.addEventListener("stop", () => {
        state.recorderState = "inactive";
      });

      // Force periodic chunks so we can verify non-silent capture while the
      // recording is still in progress. The encoder concatenates them exactly
      // as it would for a normal stop.
      const originalStart = recorder.start.bind(recorder);
      recorder.start = (timeslice?: number) => {
        state.recorderState = "recording";
        return originalStart(timeslice ?? 250);
      };

      const originalStop = recorder.stop.bind(recorder);
      recorder.stop = () => {
        state.recorderState = "inactive";
        return originalStop();
      };

      return recorder;
    }

    AuroicMediaRecorder.prototype = OriginalRecorder.prototype;
    Object.setPrototypeOf(AuroicMediaRecorder, OriginalRecorder);
    if (OriginalRecorder.isTypeSupported) {
      (AuroicMediaRecorder as any).isTypeSupported =
        OriginalRecorder.isTypeSupported.bind(OriginalRecorder);
    }
    w.MediaRecorder = AuroicMediaRecorder;
  }

  async function decode(bytes: number[]) {
    const context = await resume();
    const array = new Uint8Array(bytes);
    const buffer = await context.decodeAudioData(array.buffer.slice(0));
    state.pendingBuffer = buffer;
    return {
      duration: buffer.duration,
      state: context.state,
      currentTime: context.currentTime,
    };
  }

  async function feed(bytes?: number[]) {
    const context = await resume();
    let buffer = state.pendingBuffer;
    if (bytes && bytes.length) {
      const array = new Uint8Array(bytes);
      buffer = await context.decodeAudioData(array.buffer.slice(0));
      state.pendingBuffer = buffer;
    }
    if (!buffer) throw new Error("No decoded audio buffer available");

    if (state.source) {
      try {
        state.source.stop();
      } catch {
        // Already stopped.
      }
      state.source = null;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(state.destination);
    if (state.analyser) source.connect(state.analyser);

    // Keep an inaudible branch connected to the hardware destination so the
    // audio graph is not considered idle by Chromium.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(mute);
    mute.connect(context.destination);

    stopSampling();
    state.peak = 0;
    state.sampleTimer = setInterval(samplePeak, 50);

    source.start(0);
    state.source = source;
    source.onended = () => {
      samplePeak();
      stopSampling();
      if (state.source === source) state.source = null;
    };

    return {
      duration: buffer.duration,
      state: context.state,
      currentTime: context.currentTime,
    };
  }

  function getState() {
    const context = state.context;
    return {
      state: context?.state ?? null,
      currentTime: context?.currentTime ?? 0,
      chunks: state.chunks,
      lastChunkSize: state.lastChunkSize,
      recordingStreamId: state.recordingStreamId,
      captureStreamId: state.captureStreamId,
      captureRequests: state.captureRequests,
      destinationStreamId: state.destinationStreamId,
      recorderState: state.recorderState,
      sourcePlaying: Boolean(state.source),
      peak: state.peak,
    };
  }

  function resetRecorder() {
    state.chunks = 0;
    state.lastChunkSize = 0;
    state.recordingStreamId = null;
    state.captureStreamId = null;
    state.captureRequests = 0;
    state.recorderState = null;
    state.peak = 0;
  }

  function stopSource() {
    stopSampling();
    if (state.source) {
      try {
        state.source.stop();
      } catch {
        // Already stopped.
      }
      state.source = null;
    }
    state.pendingBuffer = null;
  }

  w.__auroicVoice = {
    version: 2,
    ensure,
    decode,
    feed,
    getState,
    resetRecorder,
    stopSource,
  };
}
