(function (window) {
if (!window.XMPlayer) {
  window.XMPlayer = {};
}
var player = window.XMPlayer;

if (!window.XMView) {
  window.XMView = {};
}
var XMView = window.XMView;

player.periodForNote = periodForNote;
player.prettify_effect = prettify_effect;
player.init = init;
player.load = load;
player.play = play;
player.pause = pause;
player.stop = stop;
player.cur_songpos = -1;
player.cur_pat = -1;
player.cur_row = 64;
player.cur_ticksamp = 0;
player.cur_tick = 6;
player.xm = {};  // contains all song data
player.xm.global_volume = player.max_global_volume = 128;

// exposed for testing
player.nextTick = nextTick;
player.nextRow = nextRow;
player.Envelope = Envelope;
player.EnvelopeFollower = EnvelopeFollower;
player.keyOff = keyOff;

// for pretty-printing notes
var _note_names = [
  "C-", "C#", "D-", "D#", "E-", "F-",
  "F#", "G-", "G#", "A-", "A#", "B-"];

var f_smp = 44100;  // updated by play callback, default value here

var quickRampSamples = Math.max(1, Math.round(f_smp / 200));  // ~5ms crossfade
player.quickRampSamples = quickRampSamples;

// Pre-allocated VU buffer for audio callback (sized on first use)
var vuBuffer = null;

function prettify_note(note) {
  if (note < 0) return "---";
  if (note == 96) return "^^^";
  return _note_names[note%12] + ~~(note/12);
}

function prettify_number(num) {
  if (num == -1) return "--";
  if (num < 10) return "0" + num;
  return num;
}

function prettify_volume(num) {
  if (num < 0x10) return "--";
  return num.toString(16);
}

function prettify_effect(t, p) {
  if (t >= 10) t = String.fromCharCode(55 + t);
  if (p < 16) p = '0' + p.toString(16);
  else p = p.toString(16);
  return t + p;
}

function prettify_notedata(data) {
  return (prettify_note(data[0]) + " " + prettify_number(data[1]) + " " +
      prettify_volume(data[2]) + " " +
      prettify_effect(data[3], data[4]));
}

function getstring(dv, offset, len) {
  var str = [];
  for (var i = offset; i < offset+len; i++) {
    var c = dv.getUint8(i);
    if (c === 0) break;
    str.push(String.fromCharCode(c));
  }
  return str.join('');
}

function getQuickRampSamples() {
  var n = player.quickRampSamples;
  if (typeof n !== "number" || !isFinite(n)) n = quickRampSamples;
  n = n | 0;
  if (n < 1) n = 1;
  return n;
}

function startVoiceQuickRamp(ch) {
  ch.vL = 0;
  ch.vR = 0;
  ch.rampSamplesLeft = getQuickRampSamples();
}
player.startVoiceQuickRamp = startVoiceQuickRamp;

// Amiga period LUT (1936 entries, stored in 1/4-scale to match JS period convention)
// FT2 formula: round(109568 / 2^((368+i)/192))
var amigaPeriodLUT = new Float64Array(1936);
(function() {
  for (var i = 0; i < 1936; i++) {
    amigaPeriodLUT[i] = Math.round(109568 / Math.pow(2, (368 + i) / 192.0)) / 4;
  }
})();

// FT2's exact vibrato/tremolo sine table (32 entries, half-wave, values 0-255)
var vibratoTab = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24
];

// Build 64-entry signed LUT from FT2's half-wave table (first half positive, second half negative)
var vibratoSineLUT = new Float64Array(64);
(function() {
  for (var i = 0; i < 32; i++) {
    vibratoSineLUT[i] = vibratoTab[i] / 256;
    vibratoSineLUT[i + 32] = -vibratoTab[i] / 256;
  }
})();

// Sqrt panning LUT: 257 entries for sqrt(x/256), x = 0..256
var sqrtPanLUT = new Float64Array(257);
(function() {
  for (var i = 0; i <= 256; i++) {
    sqrtPanLUT[i] = Math.sqrt(i / 256);
  }
})();

function updateChannelPeriod(ch, period) {
  if (period <= 0) return;
  var freq;
  if (player.xm.flags & 1) {
    freq = 8363 * Math.pow(2, (1152.0 - period) / 192.0);
  } else {
    freq = 3583964 / period;
  }
  ch.doff = freq / f_smp;
}

function periodForNote(ch, note) {
  if (player.xm.flags & 1) {
    // Linear periods: direct formula (equivalent to linearPeriodLUT / 4)
    return 1920 - (note + ch.samp.note) * 16 - ch.fine / 8.0;
  } else {
    // Amiga periods: table lookup
    var noteIndex = ((note + ch.samp.note) * 16 + ((ch.fine >> 3) + 16)) | 0;
    if (noteIndex < 0) noteIndex = 0;
    if (noteIndex >= 1936) noteIndex = 1935;
    return amigaPeriodLUT[noteIndex];
  }
}

// FT2's auto-vibrato sine table (range -64..+64, negative-first)
var autoVibSineTab = new Int8Array([
   0, -2, -3, -5, -6, -8, -9,-11,-12,-14,-16,-17,-19,-20,-22,-23,
 -24,-26,-27,-29,-30,-32,-33,-34,-36,-37,-38,-39,-41,-42,-43,-44,
 -45,-46,-47,-48,-49,-50,-51,-52,-53,-54,-55,-56,-56,-57,-58,-59,
 -59,-60,-60,-61,-61,-62,-62,-62,-63,-63,-63,-64,-64,-64,-64,-64,
 -64,-64,-64,-64,-64,-64,-63,-63,-63,-62,-62,-62,-61,-61,-60,-60,
 -59,-59,-58,-57,-56,-56,-55,-54,-53,-52,-51,-50,-49,-48,-47,-46,
 -45,-44,-43,-42,-41,-39,-38,-37,-36,-34,-33,-32,-30,-29,-27,-26,
 -24,-23,-22,-20,-19,-17,-16,-14,-12,-11, -9, -8, -6, -5, -3, -2,
   0,  2,  3,  5,  6,  8,  9, 11, 12, 14, 16, 17, 19, 20, 22, 23,
  24, 26, 27, 29, 30, 32, 33, 34, 36, 37, 38, 39, 41, 42, 43, 44,
  45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 56, 57, 58, 59,
  59, 60, 60, 61, 61, 62, 62, 62, 63, 63, 63, 64, 64, 64, 64, 64,
  64, 64, 64, 64, 64, 64, 63, 63, 63, 62, 62, 62, 61, 61, 60, 60,
  59, 59, 58, 57, 56, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46,
  45, 44, 43, 42, 41, 39, 38, 37, 36, 34, 33, 32, 30, 29, 27, 26,
  24, 23, 22, 20, 19, 17, 16, 14, 12, 11,  9,  8,  6,  5,  3,  2
]);

function getAutoVibratoVal(type, pos) {
  if (type === 1)      // square
    return (pos > 127) ? 64 : -64;
  else if (type === 2) // ramp up
    return (((pos >> 1) + 64) & 127) - 64;
  else if (type === 3) // ramp down
    return (((-(pos >> 1)) + 64) & 127) - 64;
  else                 // sine
    return autoVibSineTab[pos];
}

function setCurrentPattern() {
  var nextPat = player.xm.songpats[player.cur_songpos];

  // check for out of range pattern index
  while (nextPat >= player.xm.patterns.length) {
    if (player.cur_songpos + 1 < player.xm.songpats.length) {
      // first try skipping the position
      player.cur_songpos++;
    } else if ((player.cur_songpos === player.xm.song_looppos && player.cur_songpos !== 0)
      || player.xm.song_looppos >= player.xm.songpats.length) {
      // if we allready tried song_looppos or if song_looppos
      // is out of range, go to the first position
      player.cur_songpos = 0;
    } else {
      // try going to song_looppos
      player.cur_songpos = player.xm.song_looppos;
    }

    nextPat = player.xm.songpats[player.cur_songpos];
  }

  player.cur_pat = nextPat;
}

// FT2 keyOff: set release flag and back up volume envelope tick by 1.
// This ensures one extra sample of the sustain value before the envelope
// progresses, matching FT2's exact key-off timing.
function keyOff(ch) {
  ch.release = 1;
  if (ch.inst && (ch.inst.env_vol.type & 1) && ch.env_vol) {
    if (ch.env_vol.tick > 0) ch.env_vol.tick--;
  }
}

function snapshotFadeVoice(ch) {
  if (ch.inst && ch.samp && ch.vL + ch.vR > 0) {
    var ramp = getQuickRampSamples();
    var fv = ch.fadeVoice || (ch.fadeVoice = {});
    fv.inst = ch.inst; fv.samp = ch.samp;
    fv.off = ch.off; fv.doff = ch.doff;
    fv.vL = ch.vL; fv.vR = ch.vR;
    fv.volDeltaL = -ch.vL / ramp;
    fv.volDeltaR = -ch.vR / ramp;
    fv.rampSamplesLeft = ramp;
  }
}
player.snapshotFadeVoice = snapshotFadeVoice;
player.vibratoSineLUT = vibratoSineLUT;

function triggerInstrument(ch, inst) {
  ch.release = 0;
  ch.fadeOutVol = 32768;
  if (ch.env_vol) { ch.env_vol.reset(inst.env_vol); }
  else { ch.env_vol = new EnvelopeFollower(inst.env_vol); }
  if (ch.env_pan) { ch.env_pan.reset(inst.env_pan); }
  else { ch.env_pan = new EnvelopeFollower(inst.env_pan); }
  ch.retrigcounter = 0;
  if (ch.vibratotype < 4) ch.vibratopos = 0;
  if (ch.tremolotype < 4) ch.tremolopos = 0;
  ch.tremorPos = 0;
  ch.autovibratopos = 0;
  if (inst.vib_sweep > 0) {
    ch.autoVibAmp = 0;
    ch.autoVibSweepInc = ((inst.vib_depth << 8) / inst.vib_sweep) | 0;
  } else {
    ch.autoVibAmp = inst.vib_depth << 8;
    ch.autoVibSweepInc = 0;
  }
}

function volSlideDown(ch) { ch.vol = Math.max(0, ch.vol - ch.voleffectdata); }
function volSlideUp(ch) { ch.vol = Math.min(64, ch.vol + ch.voleffectdata); }
function panSlideLeft(ch) { ch.pan = Math.max(0, ch.pan - ch.voleffectdata); }
function panSlideRight(ch) { ch.pan = Math.min(255, ch.pan + ch.voleffectdata); }

function nextRow() {
  if(player.next_row === undefined) { player.next_row = player.cur_row + 1; }
  player.cur_row = player.next_row;
  player.next_row++;

  if (player.cur_pat == -1 || player.cur_pat >= player.xm.patterns.length || player.cur_row >= player.xm.patterns[player.cur_pat].length) {
    player.cur_row = 0;
    player.next_row = 1;
    player.cur_songpos++;
    if (player.cur_songpos >= player.xm.songpats.length)
      player.cur_songpos = player.xm.song_looppos;
    setCurrentPattern();
  }
  var p = player.xm.patterns[player.cur_pat];
  var r = p[player.cur_row];
  for (var i = 0; i < r.length; i++) {
    var ch = player.xm.channelinfo[i];
    var inst = ch.inst;
    var triggernote = false;
    var hasNewInstrument = false;

    // FT2: detect note delay (EDx) early — it suppresses all tick-0 processing
    var isNoteDelay = (r[i][3] == 14 && r[i][4] >= 0xd1 && r[i][4] <= 0xdf);

    // instrument trigger
    var instrumentOnly = false;
    if (r[i][1] != -1) {
      inst = player.xm.instruments[r[i][1] - 1];
      if (inst && inst.samplemap) {
        ch.inst = inst;
        instrumentOnly = true;
        hasNewInstrument = true;
      }
    }

    // note trigger
    if (r[i][0] != -1) {
      if (r[i][0] == 96) {
        keyOff(ch);
        instrumentOnly = false;
      } else {
        if (inst && inst.samplemap) {
          ch.note = r[i][0];
          ch.samp = inst.samples[inst.samplemap[ch.note]];
          if (ch.samp) {
            triggernote = true;
          }
          instrumentOnly = false;
        }
      }
    }

    // Set effect/effectdata early (needed for portamento/delay checks below)
    ch.effect = r[i][3];
    ch.effectdata = r[i][4];
    if (ch.effect < 36) {
      ch.effectfn = player.effects_t1[ch.effect];
    } else {
      ch.effectfn = undefined;
    }

    // EDx note delay: store data for delayed trigger, skip tick-0 processing
    // FT2: ED0 is NOT treated as a delay — only ED1-EDF suppress the trigger
    if (isNoteDelay) {
      ch.delaynote = {
        note: ch.note,
        inst: inst,
        triggernote: triggernote,
        volColumn: r[i][2],
        hasInstrument: hasNewInstrument
      };
      triggernote = false;
    }

    // FT2: portamento check — BEFORE note trigger (preparePortamento + return)
    if (ch.effect == 3 || ch.effect == 5 || r[i][2] >= 0xf0) {
      if (r[i][0] != -1 && r[i][0] != 96 && ch.samp) {
        ch.periodtarget = periodForNote(ch, ch.note);
      }
      triggernote = false;
      if (inst && inst.samplemap) {
        if (ch.env_vol == undefined) {
          // note wasn't already playing; ignore portamento and just trigger
          triggernote = true;
        } else if (hasNewInstrument && r[i][0] != 96) {
          // FT2: inst+portamento = resetVolumes + triggerInstrument
          if (ch.samp) {
            ch.vol = ch.samp.vol;
            ch.pan = ch.samp.pan;
            ch.fine = ch.samp.fine;
          }
          triggerInstrument(ch, inst);
        }
      }
    }

    // FT2: instrument-only row (no note) — resetVolumes + triggerInstrument
    if (instrumentOnly && !isNoteDelay) {
      if (ch.samp) {
        ch.vol = ch.samp.vol;
        ch.pan = ch.samp.pan;
        ch.fine = ch.samp.fine;
      }
      triggerInstrument(ch, inst);
    }

    // FT2 order: triggerNote → resetVolumes → triggerInstrument → THEN effects
    if (triggernote) {
      // snapshot old voice for crossfade
      snapshotFadeVoice(ch);
      // triggerNote: restart voice
      // FT2: 9xx sample offset handled inside triggerNote
      if (ch.effect == 9) {
        if (ch.effectdata > 0) ch.offsetmemory = ch.effectdata;
        ch.off = (ch.offsetmemory || 0) * 256;
      } else {
        ch.off = 0;
      }
      // FT2: E5x (set finetune) handled inside triggerNote, before period calc
      if (ch.effect == 14 && (ch.effectdata & 0xf0) == 0x50) {
        ch.fine = ((ch.effectdata & 0x0f) << 4) - 128;
      } else {
        ch.fine = ch.samp.fine;
      }
      if (ch.note !== undefined) {
        ch.period = periodForNote(ch, ch.note);
      }
      // resetVolumes + triggerInstrument: only when instrument present on this row
      if (hasNewInstrument) {
        ch.vol = ch.samp.vol;
        ch.pan = ch.samp.pan;
        triggerInstrument(ch, inst);
      }
      // new voice ramps up from zero
      startVoiceQuickRamp(ch);
    }

    // handleEffects_TickZero: volume column effects (named functions defined above nextRow)
    ch.voleffectfn = undefined;
    ch.volColumnVol = r[i][2];  // store raw value for retrig vol override
    ch.hasVolColumn = (r[i][2] != -1);
    if (r[i][2] != -1) {  // volume column
      var v = r[i][2];
      ch.voleffectdata = v & 0x0f;
      if (v < 0x10) {
        // invalid volume column byte, ignore
      } else if (v <= 0x50) {
        if (!isNoteDelay) ch.vol = v - 0x10;
      } else if (v >= 0x60 && v < 0x70) {  // volume slide down
        ch.voleffectfn = volSlideDown;
      } else if (v >= 0x70 && v < 0x80) {  // volume slide up
        ch.voleffectfn = volSlideUp;
      } else if (v >= 0x80 && v < 0x90) {  // fine volume slide down
        if (!isNoteDelay) ch.vol = Math.max(0, ch.vol - (v & 0x0f));
      } else if (v >= 0x90 && v < 0xa0) {  // fine volume slide up
        if (!isNoteDelay) ch.vol = Math.min(64, ch.vol + (v & 0x0f));
      } else if (v >= 0xa0 && v < 0xb0) {  // vibrato speed
        if (!isNoteDelay && (v & 0x0f)) ch.vibratospeed = v & 0x0f;
      } else if (v >= 0xb0 && v < 0xc0) {  // vibrato w/ depth
        if (!isNoteDelay && (v & 0x0f)) ch.vibratodepth = (v & 0x0f) * 2;
        ch.voleffectfn = player.effects_t1[4];  // use vibrato effect directly
      } else if (v >= 0xc0 && v < 0xd0) {  // set panning
        if (!isNoteDelay) ch.pan = (v & 0x0f) << 4;
      } else if (v >= 0xd0 && v < 0xe0) {  // panning slide left
        ch.voleffectdata = v & 0x0f;
        ch.voleffectfn = panSlideLeft;
      } else if (v >= 0xe0 && v < 0xf0) {  // panning slide right
        ch.voleffectdata = v & 0x0f;
        ch.voleffectfn = panSlideRight;
      } else if (v >= 0xf0 && v <= 0xff) {  // portamento
        if (v & 0x0f) {
          ch.portaspeed = (v & 0x0f) << 4;
        }
        ch.voleffectfn = player.effects_t1[3];  // just run 3x0
      }
    }

    // handleEffects_TickZero: normal effects
    if (ch.effect < 36 && !isNoteDelay) {
      var eff_t0 = player.effects_t0[ch.effect];
      if (eff_t0) eff_t0(ch, ch.effectdata);
    }
  }
  // FT2: resolve E6x pattern loop (pBreakFlag) before Bxx/Dxx
  if (player.pBreakFlag) {
    player.pBreakFlag = false;
    player.next_row = player.pBreakPos;
  }
  // resolve deferred Bxx/Dxx position jumps after all channels processed
  if (player.posJumpFlag) {
    if (player.posJumpPos !== undefined) {
      player.cur_songpos = player.posJumpPos;
    } else {
      player.cur_songpos++;
    }
    if (player.cur_songpos >= player.xm.songpats.length)
      player.cur_songpos = player.xm.song_looppos;
    player.next_row = player.pBreakPos || 0;
    setCurrentPattern();
    // FT2: if pBreakPos exceeds the target pattern's row count, reset to 0
    if (player.next_row >= player.xm.patterns[player.cur_pat].length) {
      player.next_row = 0;
    }
    player.posJumpFlag = false;
    player.posJumpPos = undefined;
  }
  player.pBreakPos = undefined;
}

function triggerNote(ch) {
  var d = ch.delaynote;
  if (!d || !d.triggernote) return;
  var inst = d.inst;
  if (!inst || !inst.samplemap) return;
  // snapshot old voice for crossfade
  snapshotFadeVoice(ch);
  if (ch.effect == 9 && ch.offsetmemory) {
    ch.off = ch.offsetmemory * 256;
  } else {
    ch.off = 0;
  }
  triggerInstrument(ch, inst);
  if (d.note !== undefined && ch.samp) {
    ch.period = periodForNote(ch, d.note);
  }
  // FT2: resetVolumes — restore vol/pan from sample (only when instrument present)
  if (d.hasInstrument && ch.samp) {
    ch.vol = ch.samp.vol;
    ch.pan = ch.samp.pan;
    ch.fine = ch.samp.fine;
  }
  // FT2: apply volume column set-volume/set-panning after delayed trigger
  if (d.volColumn >= 0x10 && d.volColumn <= 0x50) {
    ch.vol = d.volColumn - 0x10;
  } else if (d.volColumn >= 0xc0 && d.volColumn < 0xd0) {
    ch.pan = (d.volColumn & 0x0f) << 4;
  }
  // new voice ramps up from zero
  startVoiceQuickRamp(ch);
}
player.triggerNote = triggerNote;
player.triggerInstrument = triggerInstrument;

function Envelope(points, type, sustain, loopstart, loopend) {
  this.points = points;
  this.type = type;
  this.sustain = sustain;
  this.loopstart = points[loopstart*2];
  this.loopend = points[loopend*2];
  this.loopendIndex = loopend;
}

Envelope.prototype.Get = function(ticks) {
  // TODO: optimize follower with ptr
  // or even do binary search here
  var y0;
  var env = this.points;
  for (var i = 0; i < env.length; i += 2) {
    y0 = env[i+1];
    if (ticks < env[i]) {
      var x0 = env[i-2];
      y0 = env[i-1];
      var dx = env[i] - x0;
      var dy = env[i+1] - y0;
      return y0 + (ticks - x0) * dy / dx;
    }
  }
  return y0;
};

function EnvelopeFollower(env) {
  this.env = env;
  this.tick = 0;
}

EnvelopeFollower.prototype.reset = function(env) {
  this.env = env;
  this.tick = 0;
};

EnvelopeFollower.prototype.Tick = function(release) {
  var value = this.env.Get(this.tick);

  // if we're sustaining a note, stop advancing the tick counter
  if (!release && (this.env.type & 2) &&
      this.tick >= this.env.points[this.env.sustain*2]) {
    return this.env.points[this.env.sustain*2 + 1];
  }

  this.tick++;
  if (this.env.type & 4) {  // envelope loop
    if (this.tick >= this.env.loopend) {
      // FT2: suppress loop when sustain point is at loop end and note is released
      if ((this.env.type & 2) && this.env.loopendIndex === this.env.sustain && release) {
        // stay at sustain/loop end, don't loop back
      } else {
        this.tick -= this.env.loopend - this.env.loopstart;
      }
    }
  }
  return value;
};

function nextTick() {
  player.cur_tick++;
  var j, ch;
  var pattDelayTick = false;
  for (j = 0; j < player.xm.nchan; j++) {
    ch = player.xm.channelinfo[j];
    ch.periodoffset = 0;
    ch.voloffset = 0;
  }
  if (player.cur_tick >= player.xm.tempo) {
    if (player.patterndelay !== undefined) {
      if (player.patterndelay > 0) {
        player.patterndelay--;
        player.cur_tick = 0;
        // FT2: during pattern delay repeats, tick-0 runs non-zero effects
        pattDelayTick = true;
      } else {
        player.patterndelay = undefined;
        player.cur_tick = 0;
        nextRow();
      }
    } else {
      player.cur_tick = 0;
      nextRow();
    }
  }
  for (j = 0; j < player.xm.nchan; j++) {
    ch = player.xm.channelinfo[j];
    var inst = ch.inst;
    if (player.cur_tick !== 0 || pattDelayTick) {
      if(ch.voleffectfn) ch.voleffectfn(ch);
      if(ch.effectfn) ch.effectfn(ch);
    }
    if (inst === undefined) continue;
    if (ch.env_vol === undefined) continue;
    ch.volE = ch.env_vol.Tick(ch.release);
    ch.panE = ch.env_pan.Tick(ch.release);
    // key-off with no volume envelope: immediately silence (FT2 behavior)
    if (ch.release && !(inst.env_vol.type & 1)) {
      ch.volE = 0;
    }
    // process fadeout after key-off (only if volume envelope is enabled)
    if (ch.release && inst.env_vol && (inst.env_vol.type & 1)) {
      ch.fadeOutVol = Math.max(0, ch.fadeOutVol - (inst.vol_fadeout || 0));
    }
    // auto-vibrato: applied every tick, uses instrument parameters
    var avPeriodOffset = 0;
    if (inst.vib_depth > 0) {
      var autoVibAmp;
      if (ch.autoVibSweepInc > 0) {
        // FT2: on key-off during sweep, autoVibAmp = sweep increment (not accumulated)
        autoVibAmp = ch.autoVibSweepInc;
        if (!ch.release) {
          autoVibAmp += ch.autoVibAmp;
          if ((autoVibAmp >> 8) > inst.vib_depth) {
            autoVibAmp = inst.vib_depth << 8;
            ch.autoVibSweepInc = 0;
          }
          ch.autoVibAmp = autoVibAmp;
        }
      } else {
        autoVibAmp = ch.autoVibAmp;
      }
      var autoVibVal = getAutoVibratoVal(inst.vib_type, ch.autovibratopos);
      // FT2: (val * amp) >> 14, in FT2 period scale. JS periods are 1/4, so >> 16
      avPeriodOffset = (autoVibVal * autoVibAmp) / 65536;
      ch.autovibratopos = (ch.autovibratopos + inst.vib_rate) & 255;
    }
    var finalPeriod = ch.period + ch.periodoffset + avPeriodOffset;
    // FT2: clamp period — if >= 32000 (8000 in JS 1/4-scale), set to 0 (silence)
    if (finalPeriod >= 8000) finalPeriod = 0;
    updateChannelPeriod(ch, finalPeriod);
  }
}

function MixChannelIntoBuf(ch, start, end, dataL, dataR) {
  var inst = ch.inst;
  var instsamp = ch.samp;
  var loop = false;
  var looplen = 0, loopstart = 0;

  if (instsamp === undefined || inst === undefined || ch.mute) {
    return 0;
  }

  var samp = instsamp.sampledata;
  var sample_end = instsamp.len;
  if ((instsamp.type & 3) == 1 && instsamp.looplen > 0) {
    loop = true;
    loopstart = instsamp.loop;
    looplen = instsamp.looplen;
    sample_end = loopstart + looplen;
  }
  var volE = ch.volE / 64.0;    // current volume envelope
  var fadeOut = (ch.fadeOutVol !== undefined ? ch.fadeOutVol : 32768) / 32768.0;
  // panning formula from spec: FinalPan = Pan + ((EnvPan-32)*(128-|Pan-128|)/32)
  var finalPan = ch.pan + (ch.panE - 32) * (128 - Math.abs(ch.pan - 128)) / 32;
  var p = finalPan - 128;  // center around 0
  var vol = Math.max(0, Math.min(64, ch.vol + ch.voloffset));
  var panL = Math.max(0, Math.min(256, (128 - p) | 0));
  var panR = Math.max(0, Math.min(256, (128 + p) | 0));
  var globalVol = player.xm.global_volume;
  var volL = globalVol * fadeOut * volE * sqrtPanLUT[panL] * vol / (64 * 128);
  var volR = globalVol * fadeOut * volE * sqrtPanLUT[panR] * vol / (64 * 128);
  if (volL < 0) volL = 0;
  if (volR < 0) volR = 0;
  // FT2: advance sample position even when volume is zero (silenceMixRoutine).
  // Only take the fast path when both current AND target volumes are zero;
  // if current is non-zero we must fall through to ramp down properly.
  if (volR === 0 && volL === 0 && ch.vL <= 0 && ch.vR <= 0) {
    var numOutputSamples = end - start;
    var newOff = ch.off + numOutputSamples * ch.doff;
    if (newOff >= sample_end) {
      if (loop) {
        newOff = loopstart + ((newOff - loopstart) % looplen);
      }
      // non-looping: position past end, voice naturally done
    }
    ch.off = newOff;
    ch.rampSamplesLeft = 0;
    return 0;
  }
  // FT2: if position already past sample end (e.g. 9xx offset), voice is inactive
  if (ch.off >= sample_end) {
    ch.vL = volL; ch.vR = volR;
    ch.rampSamplesLeft = 0;
    return 0;
  }
  var k = ch.off;
  var dk = ch.doff;
  var Vrms = 0;

  // linear per-sample volume ramp (tick-length, or quick note-on ramp)
  var ticklen = end - start;
  var vL = ch.vL;
  var vR = ch.vR;
  var rampSamples = ticklen;
  if (ch.rampSamplesLeft > 0) {
    rampSamples = Math.min(rampSamples, ch.rampSamplesLeft);
  }
  var rampLeft = rampSamples;
  var volDeltaL = (volL - vL) / rampSamples;
  var volDeltaR = (volR - vR) / rampSamples;

  var i = start;
  var failsafe = 100;
  while (i < end) {
    if (failsafe-- === 0) break;
    if (k >= sample_end) {
      if (loop) {
        k = loopstart + (k - loopstart) % looplen;
      } else {
        // FT2: voice becomes inactive but channel data (inst/samp) persists.
        // This allows Rxy retrig to restart the sample later.
        ch.off = k;
        ch.lastSample = samp[Math.min(k | 0, samp.length - 1)] || 0;
        // snap to target volume (not mid-ramp) so silence path works on next tick
        ch.vL = volL; ch.vR = volR;
        ch.rampSamplesLeft = 0;
        return Vrms;
      }
    }
    var next_event = Math.max(1, Math.min(end, i + (sample_end - k) / dk));
    var segEnd = next_event;
    if (rampLeft > 0) {
      segEnd = Math.min(segEnd, i + rampLeft);
    }
    var segStart = i;

    // unrolled 8x with linear interpolation
    var ki, kf, s;
    for (; i + 7 < segEnd; i+=8) {
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i]+=vL*s; dataR[i]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i+1]+=vL*s; dataR[i+1]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i+2]+=vL*s; dataR[i+2]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i+3]+=vL*s; dataR[i+3]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i+4]+=vL*s; dataR[i+4]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i+5]+=vL*s; dataR[i+5]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i+6]+=vL*s; dataR[i+6]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf; k+=dk;
      dataL[i+7]+=vL*s; dataR[i+7]+=vR*s; Vrms+=(vL+vR)*s*s; vL+=volDeltaL; vR+=volDeltaR;
    }

    for (; i < segEnd; i++) {
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf;
      dataL[i]+=vL*s; dataR[i]+=vR*s;
      Vrms+=(vL+vR)*s*s;
      vL+=volDeltaL; vR+=volDeltaR;
      k+=dk;
    }

    if (rampLeft > 0) {
      rampLeft -= segEnd - segStart;
      if (rampLeft <= 0) {
        rampLeft = 0;
        vL = volL;
        vR = volR;
        volDeltaL = 0;
        volDeltaR = 0;
      }
    }
  }
  ch.off = k;
  ch.lastSample = s;
  // snap to target to avoid float drift
  ch.vL = volL;
  ch.vR = volR;
  ch.rampSamplesLeft = rampLeft;
  return Vrms * 0.5;
}

function MixFadeVoiceIntoBuf(fv, start, end, dataL, dataR) {
  var instsamp = fv.samp;
  var loop = false;
  var looplen = 0, loopstart = 0;

  var samp = instsamp.sampledata;
  var sample_end = instsamp.len;
  if ((instsamp.type & 3) == 1 && instsamp.looplen > 0) {
    loop = true;
    loopstart = instsamp.loop;
    looplen = instsamp.looplen;
    sample_end = loopstart + looplen;
  }

  var k = fv.off;
  var dk = fv.doff;
  var vL = fv.vL;
  var vR = fv.vR;
  var volDeltaL = fv.volDeltaL;
  var volDeltaR = fv.volDeltaR;
  var rampLeft = fv.rampSamplesLeft;

  var i = start;
  var failsafe = 100;
  while (i < end && rampLeft > 0) {
    if (failsafe-- === 0) break;
    if (k >= sample_end) {
      if (loop) {
        k = loopstart + (k - loopstart) % looplen;
      } else {
        rampLeft = 0;
        break;
      }
    }
    var segEnd = Math.min(end, i + rampLeft);
    var next_event = Math.max(1, Math.min(segEnd, i + (sample_end - k) / dk));

    var ki, kf, s;
    for (; i < next_event; i++) {
      ki=k|0; kf=k-ki; s=samp[ki]+(samp[ki+1]-samp[ki])*kf;
      dataL[i]+=vL*s; dataR[i]+=vR*s;
      vL+=volDeltaL; vR+=volDeltaR;
      k+=dk;
      rampLeft--;
    }
  }

  fv.off = k;
  fv.vL = vL;
  fv.vR = vR;
  fv.rampSamplesLeft = rampLeft;
}

function audio_cb(e) {
  var nchan = player.xm.nchan;
  var buflen = e.outputBuffer.length;
  var dataL = e.outputBuffer.getChannelData(0);
  var dataR = e.outputBuffer.getChannelData(1);
  var i, j, k;

  for (i = 0; i < buflen; i++) {
    dataL[i] = 0;
    dataR[i] = 0;
  }

  // ensure pre-allocated VU buffer matches channel count
  if (!vuBuffer || vuBuffer.length < nchan) {
    vuBuffer = new Float32Array(nchan);
  }

  var offset = 0;
  var ticklen = f_smp * 2.5 / player.xm.bpm;
  var scopewidth = XMView.scope_width;

  while(buflen > 0) {
    if (player.cur_pat == -1 || player.cur_ticksamp >= ticklen) {
      nextTick(f_smp);
      player.cur_ticksamp -= ticklen;
      ticklen = f_smp * 2.5 / player.xm.bpm;  // recalculate after possible Fxx BPM change
    }
    var tickduration = Math.min(buflen, ((ticklen - player.cur_ticksamp) | 0) || 1);
    // reuse pre-allocated VU buffer
    for (j = 0; j < nchan; j++) vuBuffer[j] = 0;
    var scopes = undefined;
    for (j = 0; j < nchan; j++) {
      var scope;
      if (tickduration >= 4*scopewidth) {
        scope = new Float32Array(scopewidth);
        for (k = 0; k < scopewidth; k++) {
          scope[k] = -dataL[offset+k*4] - dataR[offset+k*4];
        }
      }

      var ch = player.xm.channelinfo[j];
      vuBuffer[j] = MixChannelIntoBuf(ch, offset, offset + tickduration, dataL, dataR) /
        tickduration;
      if (ch.fadeVoice) {
        MixFadeVoiceIntoBuf(ch.fadeVoice, offset, offset + tickduration, dataL, dataR);
        if (ch.fadeVoice.rampSamplesLeft <= 0) ch.fadeVoice = null;
      }

      if (tickduration >= 4*scopewidth) {
        for (k = 0; k < scopewidth; k++) {
          scope[k] += dataL[offset+k*4] + dataR[offset+k*4];
        }
        if (scopes === undefined) scopes = [];
        scopes.push(scope);
      }
    }
    if (XMView.pushEvent) {
      XMView.pushEvent({
        t: e.playbackTime + (0.0 + offset) / f_smp,
        vu: vuBuffer,
        scopes: scopes,
        songpos: player.cur_songpos,
        pat: player.cur_pat,
        row: player.cur_row
      });
    }
    offset += tickduration;
    player.cur_ticksamp += tickduration;
    buflen -= tickduration;
  }
}

function ConvertSample(array, bits) {
  var len = array.length;
  var acc = 0;
  var samp, b, k;
  if (bits === 0) {  // 8 bit sample
    samp = new Float32Array(len);
    for (k = 0; k < len; k++) {
      acc += array[k];
      b = acc&255;
      if (b & 128) b = b-256;
      samp[k] = b / 128.0;
    }
    return samp;
  } else {
    len /= 2;
    samp = new Float32Array(len);
    for (k = 0; k < len; k++) {
      b = array[k*2] + (array[k*2 + 1] << 8);
      if (b & 32768) b = b-65536;
      acc = (acc + b) & 0xFFFF;
      if (acc >= 32768) acc -= 65536;
      samp[k] = acc / 32768.0;
    }
    return samp;
  }
}

// optimization: unroll short sample loops so we can run our inner mixing loop
// uninterrupted for as long as possible; this also handles pingpong loops.
function UnrollSampleLoop(samp) {
  var nloops = ((2048 + samp.looplen - 1) / samp.looplen) | 0;
  var pingpong = samp.type & 2;
  if (pingpong) {
    // make sure we have an even number of loops if we are pingponging
    nloops = (nloops + 1) & (~1);
  }
  var samplesiz = samp.loop + nloops * samp.looplen;
  var data = new Float32Array(samplesiz);
  for (var i = 0; i < samp.loop; i++) {
    data[i] = samp.sampledata[i];
  }
  for (var j = 0; j < nloops; j++) {
    var k;
    if ((j&1) && pingpong) {
      for (k = samp.looplen - 1; k >= 0; k--) {
        data[i++] = samp.sampledata[samp.loop + k];
      }
    } else {
      for (k = 0; k < samp.looplen; k++) {
        data[i++] = samp.sampledata[samp.loop + k];
      }
    }
  }
  samp.sampledata = data;
  samp.looplen = nloops * samp.looplen;
  samp.type = 1;
}

function load(arrayBuf) {
  var dv = new DataView(arrayBuf);
  player.xm = {};

  player.xm.songname = getstring(dv, 17, 20);
  var hlen = dv.getUint32(0x3c, true) + 0x3c;
  var songlen = dv.getUint16(0x40, true);
  player.xm.song_looppos = dv.getUint16(0x42, true);
  player.xm.nchan = dv.getUint16(0x44, true);
  var npat = dv.getUint16(0x46, true);
  var ninst = dv.getUint16(0x48, true);
  player.xm.flags = dv.getUint16(0x4a, true);
  player.xm.tempo = dv.getUint16(0x4c, true);
  player.xm.bpm = dv.getUint16(0x4e, true);
  player.xm.channelinfo = [];
  player.xm.global_volume = player.max_global_volume;

  var i, j, k;

  for (i = 0; i < player.xm.nchan; i++) {
    player.xm.channelinfo.push({
      number: i,
      lastSample: 0,
      vol: 0,
      pan: 128,
      period: 1920 - 48*16,
      vL: 0, vR: 0,   // left right volume envelope followers (changes per sample)
      rampSamplesLeft: 0,
      fadeVoice: null,
      mute: 0,
      volE: 0, panE: 0,
      fadeOutVol: 32768,
      retrig: 0,
      autovibratopos: 0,
      autoVibAmp: 0,
      autoVibSweepInc: 0,
      vibratopos: 0,
      vibratodepth: 1,
      vibratospeed: 1,
      vibratotype: 0,
      tremolopos: 0,
      tremolodepth: 0,
      tremolospeed: 0,
      tremolotype: 0,
      voloffset: 0,
    });
  }

  player.xm.songpats = [];
  for (i = 0; i < songlen; i++) {
    player.xm.songpats.push(dv.getUint8(0x50 + i));
  }

  var idx = hlen;
  player.xm.patterns = [];
  for (i = 0; i < npat; i++) {
    var pattern = [];
    var patheaderlen = dv.getUint32(idx, true);
    var patrows = dv.getUint16(idx + 5, true);
    var patsize = dv.getUint16(idx + 7, true);
    idx += 9;
    if (patsize > 0) {
      for (j = 0; j < patrows; j++) {
        var row = [];
        for (k = 0; k < player.xm.nchan; k++) {
          var byte0 = dv.getUint8(idx); idx++;
          var note = -1, inst = -1, vol = -1, efftype = 0, effparam = 0;
          if (byte0 & 0x80) {
            if (byte0 & 0x01) {
              note = dv.getUint8(idx) - 1; idx++;
            }
            if (byte0 & 0x02) {
              inst = dv.getUint8(idx); idx++;
            }
            if (byte0 & 0x04) {
              vol = dv.getUint8(idx); idx++;
            }
            if (byte0 & 0x08) {
              efftype = dv.getUint8(idx); idx++;
            }
            if (byte0 & 0x10) {
              effparam = dv.getUint8(idx); idx++;
            }
          } else {
            // byte0 is note from 1..96 or 0 for nothing or 97 for release
            // so we subtract 1 so that C-0 is stored as 0
            note = byte0 - 1;
            inst = dv.getUint8(idx); idx++;
            vol = dv.getUint8(idx); idx++;
            efftype = dv.getUint8(idx); idx++;
            effparam = dv.getUint8(idx); idx++;
            // XM format: 0 means "no data" for these fields
            if (inst === 0) inst = -1;
            if (vol === 0) vol = -1;
          }
          var notedata = [note, inst, vol, efftype, effparam];
          row.push(notedata);
        }
        pattern.push(row);
      }
    } else {
      // FT2: empty patterns (data size = 0) get default 64 rows of silence
      for (j = 0; j < patrows; j++) {
        var row = [];
        for (k = 0; k < player.xm.nchan; k++) {
          row.push([-1, -1, -1, 0, 0]);
        }
        pattern.push(row);
      }
    }
    player.xm.patterns.push(pattern);
  }

  player.xm.instruments = [];
  // now load instruments
  for (i = 0; i < ninst; i++) {
    var hdrsiz = dv.getUint32(idx, true);
    var instname = getstring(dv, idx+0x4, 22);
    var nsamp = dv.getUint16(idx+0x1b, true);
    var inst = {
      'name': instname,
      'number': i,
    };
    if (nsamp > 0) {
      var samplemap = new Uint8Array(96);
      samplemap.set(new Uint8Array(arrayBuf, idx+33, 96));

      var env_nvol = dv.getUint8(idx+225);
      var env_vol_type = dv.getUint8(idx+233);
      var env_vol_sustain = dv.getUint8(idx+227);
      var env_vol_loop_start = dv.getUint8(idx+228);
      var env_vol_loop_end = dv.getUint8(idx+229);
      var env_npan = dv.getUint8(idx+226);
      var env_pan_type = dv.getUint8(idx+234);
      var env_pan_sustain = dv.getUint8(idx+230);
      var env_pan_loop_start = dv.getUint8(idx+231);
      var env_pan_loop_end = dv.getUint8(idx+232);
      var vol_fadeout = dv.getUint16(idx+239, true);
      var vib_type = dv.getUint8(idx+235);
      var vib_sweep = dv.getUint8(idx+236);
      var vib_depth = dv.getUint8(idx+237);
      var vib_rate = dv.getUint8(idx+238);
      var env_vol = [];
      for (j = 0; j < env_nvol*2; j++) {
        env_vol.push(dv.getUint16(idx+129+j*2, true));
      }
      var env_pan = [];
      for (j = 0; j < env_npan*2; j++) {
        env_pan.push(dv.getUint16(idx+177+j*2, true));
      }
      var samphdrsiz = dv.getUint32(idx+0x1d, true);
      idx += hdrsiz;
      var totalsamples = 0;
      var samps = [];
      for (j = 0; j < nsamp; j++) {
        var samplen = dv.getUint32(idx, true);
        var samploop = dv.getUint32(idx+4, true);
        var samplooplen = dv.getUint32(idx+8, true);
        var sampvol = dv.getUint8(idx+12);
        var sampfinetune = dv.getInt8(idx+13);
        var samptype = dv.getUint8(idx+14);
        var samppan = dv.getUint8(idx+15);
        var sampnote = dv.getInt8(idx+16);
        var sampname = getstring(dv, idx+18, 22);
        var sampleoffset = totalsamples;
        if (samplooplen === 0) {
          samptype &= ~3;
        }
        var samp = {
          'len': samplen, 'loop': samploop,
          'looplen': samplooplen, 'note': sampnote, 'fine': sampfinetune,
          'pan': samppan, 'type': samptype, 'vol': sampvol,
          'fileoffset': sampleoffset
        };
        // length / pointers are all specified in bytes; fixup for 16-bit samples
        samps.push(samp);
        idx += samphdrsiz;
        totalsamples += samplen;
      }
      for (j = 0; j < nsamp; j++) {
        var samp = samps[j];
        samp.sampledata = ConvertSample(
            new Uint8Array(arrayBuf, idx + samp.fileoffset, samp.len), samp.type & 16);
        if (samp.type & 16) {
          samp.len /= 2;
          samp.loop /= 2;
          samp.looplen /= 2;
        }
        // unroll short loops and any pingpong loops
        if ((samp.type & 3) && (samp.looplen < 2048 || (samp.type & 2))) {
          UnrollSampleLoop(samp);
        }
        // pad sample with one extra value for safe linear interpolation
        var padded = new Float32Array(samp.sampledata.length + 1);
        padded.set(samp.sampledata);
        if (samp.type & 3) {
          // looping: wrap to loop start
          padded[samp.sampledata.length] = samp.sampledata[samp.loop];
        } else {
          // non-looping: pad with 0
          padded[samp.sampledata.length] = 0;
        }
        samp.sampledata = padded;
      }
      idx += totalsamples;
      inst.samplemap = samplemap;
      inst.samples = samps;
      inst.vol_fadeout = vol_fadeout;
      inst.vib_type = vib_type;
      inst.vib_sweep = vib_sweep;
      inst.vib_depth = vib_depth;
      inst.vib_rate = vib_rate;
      if (env_vol_type & 1) {
        inst.env_vol = new Envelope(
            env_vol,
            env_vol_type,
            env_vol_sustain,
            env_vol_loop_start,
            env_vol_loop_end);
      } else {
        // no envelope, then just make a default full-volume envelope.
        // fadeout is not processed if volume envelope is disabled (per spec)
        inst.env_vol = new Envelope([0, 64, 1, 0], 2, 0, 0, 0);
      }
      if (env_pan_type & 1) {
        inst.env_pan = new Envelope(
            env_pan,
            env_pan_type,
            env_pan_sustain,
            env_pan_loop_start,
            env_pan_loop_end);
      } else {
        // create a default empty envelope
        inst.env_pan = new Envelope([0, 32], 0, 0, 0, 0);
      }
    } else {
      idx += hdrsiz;
    }
    player.xm.instruments.push(inst);
  }

  return true;
}

var jsNode, gainNode;
var iosUnlocked = false;
function init() {
  if (!player.audioctx) {
    var audioContext = window.AudioContext || window.webkitAudioContext;
    player.audioctx = new audioContext();
    gainNode = player.audioctx.createGain();
    gainNode.gain.value = 0.1;  // master volume
  }
  // compute quickRampSamples once from actual sample rate
  f_smp = player.audioctx.sampleRate;
  quickRampSamples = Math.max(1, Math.round(f_smp / 200));
  player.quickRampSamples = quickRampSamples;
  if (player.audioctx.createScriptProcessor === undefined) {
    jsNode = player.audioctx.createJavaScriptNode(16384, 0, 2);
  } else {
    jsNode = player.audioctx.createScriptProcessor(16384, 0, 2);
  }
  jsNode.onaudioprocess = audio_cb;
  gainNode.connect(player.audioctx.destination);
  player.gainNode = gainNode;
}

player.playing = false;
function play() {
  if (!player.playing) {
    // put paused events back into action, if any
    if (XMView.resume) XMView.resume();
    // start playing
    jsNode.connect(gainNode);

    // hack to get iOS to play anything (run only once)
    if (!iosUnlocked) {
      iosUnlocked = true;
      var temp_osc = player.audioctx.createOscillator();
      temp_osc.connect(player.audioctx.destination);
      !!temp_osc.start ? temp_osc.start(0) : temp_osc.noteOn(0);
      !!temp_osc.stop ? temp_osc.stop(0) : temp_osc.noteOff(0);
      temp_osc.disconnect();
    }
  }
  player.playing = true;
}

function pause() {
  if (player.playing) {
    jsNode.disconnect(gainNode);
    if (XMView.pause) XMView.pause();
  }
  player.playing = false;
}

function stop() {
  if (player.playing) {
    jsNode.disconnect(gainNode);
    player.playing = false;
  }
  player.cur_pat = -1;
  player.cur_row = 64;
  player.cur_songpos = -1;
  player.cur_ticksamp = 0;
  player.xm.global_volume = player.max_global_volume;
  if (XMView.stop) XMView.stop();
  init();
}

})(window);
