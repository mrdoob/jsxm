(function (window) {
if (!window.XMPlayer) {
  window.XMPlayer = {};
}
var player = window.XMPlayer;

function eff_t1_0(ch) {  // arpeggio
  if (ch.effectdata !== 0 && ch.inst !== undefined) {
    // FT2 indexes arpeggioTab with countdown tick; equivalent to (tempo - tick) % 3
    var tick3 = (player.xm.tempo - player.cur_tick) % 3;
    var ofs = tick3 === 1 ? ch.effectdata >> 4 : tick3 === 2 ? ch.effectdata & 15 : 0;
    ch.periodoffset = player.periodForNote(ch, ch.note + ofs) - ch.period;
  }
}

function eff_t0_1(ch, data) {  // pitch slide up
  if (data !== 0) {
    ch.slideupspeed = data;
  }
}

function eff_t1_1(ch) {  // pitch slide up
  if (ch.slideupspeed !== undefined) {
    ch.period -= ch.slideupspeed;
    if (ch.period < 1) ch.period = 1;
  }
}

function eff_t0_2(ch, data) {  // pitch slide down
  if (data !== 0) {
    ch.slidedownspeed = data;
  }
}

function eff_t1_2(ch) {  // pitch slide down
  if (ch.slidedownspeed !== undefined) {
    // FT2 clamps at period 31999 (= 7999 in JS 1/4-scale periods)
    ch.period = Math.min(7999, ch.period + ch.slidedownspeed);
  }
}

function eff_t0_3(ch, data) {  // portamento
  if (data !== 0) {
    ch.portaspeed = data;
  }
}

function eff_t1_3(ch) {  // portamento
  if (ch.periodtarget !== undefined && ch.portaspeed !== undefined) {
    if (ch.period > ch.periodtarget) {
      ch.period = Math.max(ch.periodtarget, ch.period - ch.portaspeed);
    } else {
      ch.period = Math.min(ch.periodtarget, ch.period + ch.portaspeed);
    }
    if (ch.glissando) {
      // round to nearest semitone (16 period units per semitone)
      ch.periodoffset = Math.round(ch.period / 16) * 16 - ch.period;
    }
  }
}

function eff_t0_4(ch, data) {  // vibrato
  if (data & 0x0f) {
    ch.vibratodepth = (data & 0x0f) * 2;
  }
  if (data >> 4) {
    ch.vibratospeed = data >> 4;
  }
  eff_t1_4(ch);
}

function eff_t1_4(ch) {  // vibrato
  ch.periodoffset = getVibratoDelta(ch.vibratotype, ch.vibratopos) * ch.vibratodepth;
  // FT2 updates vibratoPos on every tick including tick 0
  ch.vibratopos += ch.vibratospeed;
  ch.vibratopos &= 63;
}

// Vibrato sine LUT defined in xm.js; reference it from player
function getVibratoDelta(type, x) {
  var delta = 0;
  switch (type & 0x03) {
    case 1: // ramp (FT2: index<<3, then bitwise NOT for negative half)
      var idx = x & 31;
      delta = x < 32 ? (idx << 3) / 256 : -((255 - (idx << 3)) & 0xFF) / 256;
      break;
    case 2: // square
    case 3: // random (in FT2 these two are the same)
      delta = x < 32 ? 1 : -1;
      break;
    case 0:
    default: // sine
      delta = player.vibratoSineLUT[x];
      break;
  }
  return delta;
}

function eff_t0_7(ch, data) {  // tremolo
  if (data & 0x0f) {
    ch.tremolodepth = data & 0x0f;
  }
  if (data >> 4) {
    ch.tremolospeed = data >> 4;
  }
  eff_t1_7(ch);
}

function eff_t1_7(ch) {  // tremolo
  // FT2 bug: uses vibratoPos for sign instead of tremoloPos (in both
  // the ramp waveform shape and the overall sign determination)
  var idx = ch.tremolopos & 31;
  var amp;
  switch (ch.tremolotype & 3) {
    case 1: // ramp — FT2 bug: ramp shape flipped by vibratoPos
      amp = (idx << 3) / 256;
      if (ch.vibratopos >= 32) amp = ((255 - (idx << 3)) & 0xFF) / 256;
      break;
    case 2:
    case 3: // square
      amp = 1;
      break;
    case 0:
    default: // sine (half-wave lookup, always positive)
      amp = player.vibratoSineLUT[idx];
      break;
  }
  // Overall sign from tremoloPos (correct in FT2; the vibratoPos bug only affects ramp shape)
  ch.voloffset = (ch.tremolopos >= 32 ? -amp : amp) * ch.tremolodepth * 4;
  ch.tremolopos += ch.tremolospeed;
  ch.tremolopos &= 63;
}

function eff_t1_5(ch) {  // portamento + volume slide
  eff_t1_a(ch);
  eff_t1_3(ch);
}

function eff_t1_6(ch) {  // vibrato + volume slide
  eff_t1_a(ch);
  eff_t1_4(ch);
}

function eff_t0_8(ch, data) {  // set panning
  ch.pan = data;
}

function eff_t0_9(ch, data) {  // sample offset
  // FT2: only stores the offset memory here; actual offset is applied in triggerNote()
  if (data !== 0) ch.offsetmemory = data;
}

function eff_t0_a(ch, data) {  // volume slide
  if (data) {
    // FT2: high nibble takes priority over low nibble
    if (data & 0xf0) {
      ch.volumeslide = data >> 4;
    } else {
      ch.volumeslide = -(data & 0x0f);
    }
  }
}

function eff_t1_a(ch) {  // volume slide
  if (ch.volumeslide !== undefined) {
    ch.vol = Math.max(0, Math.min(64, ch.vol + ch.volumeslide));
  }
}

function eff_t0_b(ch, data) {  // song jump (deferred)
  player.posJumpFlag = true;
  player.posJumpPos = data;
  player.pBreakPos = 0;  // FT2: Bxx resets pBreakPos
}

function eff_t0_c(ch, data) {  // set volume
  ch.vol = Math.min(64, data);
}

function eff_t0_d(ch, data) {  // pattern break (deferred)
  player.posJumpFlag = true;
  player.pBreakPos = (data >> 4) * 10 + (data & 0x0f);
  if (player.pBreakPos > 63) player.pBreakPos = 0;
}

function eff_t0_e(ch, data) {  // extended effects!
  var eff = data >> 4;
  data = data & 0x0f;
  switch (eff) {
    case 1:  // fine porta up
      if (data !== 0) ch.fineportaup = data;
      else data = ch.fineportaup || 0;
      ch.period -= data;
      if (ch.period < 1) ch.period = 1;
      break;
    case 2:  // fine porta down
      if (data !== 0) ch.fineportadown = data;
      else data = ch.fineportadown || 0;
      ch.period = Math.min(7999, ch.period + data);
      break;
    case 3:  // glissando control
      ch.glissando = data;
      break;
    case 4:  // set vibrato waveform
      ch.vibratotype = data & 0x07;
      break;
    case 5:  // finetune
      ch.fine = (data << 4) - 128;
      break;
    case 6:  // pattern loop
      if (data == 0) {
        ch.loopstart = player.cur_row;
      } else if (ch.loopremaining === undefined || ch.loopremaining === 0) {
        ch.loopremaining = data;
        player.pBreakPos = ch.loopstart || 0;
        player.pBreakFlag = true;
      } else if (--ch.loopremaining > 0) {
        player.pBreakPos = ch.loopstart || 0;
        player.pBreakFlag = true;
      }
      break;
    case 7:  // set tremolo waveform
      ch.tremolotype = data & 0x07;
      break;
    case 8:  // panning
      ch.pan = data * 0x11;
      break;
    case 0x0a:  // fine vol slide up (with memory)
      if (data === 0 && ch.finevolup !== undefined)
        data = ch.finevolup;
      ch.vol = Math.min(64, ch.vol + data);
      ch.finevolup = data;
      break;
    case 0x0b:  // fine vol slide down
      if (data === 0 && ch.finevoldown !== undefined)
        data = ch.finevoldown;
      ch.vol = Math.max(0, ch.vol - data);
      ch.finevoldown = data;
      break;
    case 9:  // retrig note
      if (data !== 0) {
        ch.retrig_interval = data;
      }
      break;
    case 0x0c:  // note cut at tick 0
      if (data === 0) ch.vol = 0;
      break;
    case 0x0d:  // note delay - handled in eff_t1_e and nextRow
      break;
    case 0x0e:  // pattern delay
      if (player.patterndelay === undefined) {
        player.patterndelay = data;
      }
      break;
    default:
      break;
  }
}

function eff_t1_e(ch) {  // extended effects tick 1+
  switch (ch.effectdata >> 4) {
    case 9:  // retrig note
      if (ch.retrig_interval &&
          player.cur_tick % ch.retrig_interval === 0) {
        var inst = ch.inst;
        if (!inst || !inst.samplemap) break;
        // FT2: triggerNote(0,0,0,ch) — crossfade + restart voice
        player.snapshotFadeVoice(ch);
        if (ch.samp) {
          ch.fine = ch.samp.fine;
        }
        if (ch.note !== undefined) {
          ch.period = player.periodForNote(ch, ch.note);
        }
        ch.off = 0;
        player.startVoiceQuickRamp(ch);
        // FT2: triggerInstrument(ch) — reset envelopes, fadeout, vibrato, etc.
        player.triggerInstrument(ch, inst);
      }
      break;
    case 0x0c:  // note cut
      if (player.cur_tick === (ch.effectdata & 0x0f)) {
        ch.vol = 0;
      }
      break;
    case 0x0d:  // note delay
      if (player.cur_tick === (ch.effectdata & 0x0f)) {
        player.triggerNote(ch);
      }
      break;
  }
}

function eff_t0_f(ch, data) {  // set tempo
  if (data === 0) return;
  else if (data < 0x20) {
    player.xm.tempo = data;
  } else {
    player.xm.bpm = data;
  }
}

function eff_t0_g(ch, data) {  // set global volume
  if (data <= 0x40) {
    // volume gets multiplied by 2 to match
    // the initial max global volume of 128
    player.xm.global_volume = Math.max(0, data * 2);
  } else {
    player.xm.global_volume = player.max_global_volume;
  }
}

function eff_t0_h(ch, data) {  // global volume slide
  if (data) {
    // FT2: high nibble takes priority (same rule as Axy), multiplied by 2
    if (data & 0xf0) {
      player.xm.global_volumeslide = (data >> 4) * 2;
    } else {
      player.xm.global_volumeslide = -(data & 0x0f) * 2;
    }
  }
}

function eff_t1_h(ch) {  // global volume slide
  if (player.xm.global_volumeslide !== undefined) {
    player.xm.global_volume = Math.max(0, Math.min(player.max_global_volume,
      player.xm.global_volume + player.xm.global_volumeslide));
  }
}

function retriggerVolume(ch) {
  switch (ch.retrig >> 4) {
    case 1: ch.vol -= 1; break;
    case 2: ch.vol -= 2; break;
    case 3: ch.vol -= 4; break;
    case 4: ch.vol -= 8; break;
    case 5: ch.vol -= 16; break;
    case 6: ch.vol = (ch.vol >> 1) + (ch.vol >> 3) + (ch.vol >> 4); break;
    case 7: ch.vol = ch.vol >> 1; break;
    case 9: ch.vol += 1; break;
    case 0x0a: ch.vol += 2; break;
    case 0x0b: ch.vol += 4; break;
    case 0x0c: ch.vol += 8; break;
    case 0x0d: ch.vol += 16; break;
    case 0x0e: ch.vol = (ch.vol * 3 / 2) | 0; break;
    case 0x0f: ch.vol *= 2; break;
  }
  ch.vol = Math.min(64, Math.max(0, ch.vol));
}

// FT2: Rxy retrig calls triggerNote (voice restart + quick vol ramp),
// NOT triggerInstrument. Envelopes, fadeout, and key-off are NOT reset.
function doMultiNoteRetrig(ch) {
  ch.retrigcounter = (ch.retrigcounter || 0) + 1;
  if (ch.retrigcounter >= (ch.retrig & 0x0f)) {
    ch.retrigcounter = 0;
    retriggerVolume(ch);
    // FT2: after volume modification, volume column set-vol/set-pan overrides
    if (ch.volColumnVol >= 0x10 && ch.volColumnVol <= 0x50) {
      ch.vol = ch.volColumnVol - 0x10;
    } else if (ch.volColumnVol >= 0xc0 && ch.volColumnVol <= 0xcf) {
      ch.pan = (ch.volColumnVol & 0x0f) << 4;
    }
    // FT2: triggerNote(0,0,0,ch) — reset finetune and recalculate period
    if (ch.samp) {
      ch.fine = ch.samp.fine;
    }
    if (ch.note !== undefined) {
      ch.period = player.periodForNote(ch, ch.note);
    }
    // FT2: triggerNote restarts voice with quick volume ramp (crossfade)
    player.snapshotFadeVoice(ch);
    ch.off = 0;
    player.startVoiceQuickRamp(ch);
  }
}

function eff_t0_r(ch, data) {  // retrigger
  if (data & 0x0f) ch.retrig = (ch.retrig & 0xf0) + (data & 0x0f);
  if (data & 0xf0) ch.retrig = (ch.retrig & 0x0f) + (data & 0xf0);
  // FT2 quirk: skip tick-0 retrigger when volume column has data
  if (!ch.hasVolColumn) {
    doMultiNoteRetrig(ch);
  }
}

function eff_t1_r(ch) {
  doMultiNoteRetrig(ch);
}

function eff_t0_p(ch, data) {  // panning slide
  if (data) {
    // FT2: high nibble takes priority
    if (data & 0xf0) {
      ch.panslide = data >> 4;
    } else {
      ch.panslide = -(data & 0x0f);
    }
  }
}

function eff_t1_p(ch) {  // panning slide
  if (ch.panslide !== undefined) {
    ch.pan = Math.max(0, Math.min(255, ch.pan + ch.panslide));
  }
}

function eff_t0_x(ch, data) {  // extra fine portamento
  var val = data & 0x0f;
  if ((data >> 4) === 1) {  // X1x - extra fine porta up
    if (val !== 0) ch.extrafineportaup = val;
    else val = ch.extrafineportaup || 0;
    // FT2: extra fine porta subtracts raw param (no *4), so in 1/4-scale periods: /4
    ch.period -= val / 4;
  } else if ((data >> 4) === 2) {  // X2x - extra fine porta down
    if (val !== 0) ch.extrafineportadown = val;
    else val = ch.extrafineportadown || 0;
    ch.period += val / 4;
  }
}

function eff_t0_t(ch, data) {  // tremor
  if (data) {
    ch.tremorParam = data;
  }
}

function eff_t1_t(ch) {  // tremor
  // FT2 tremor: tremorPos is a packed byte with bit 7 = sign (0x80=on, 0x00=off),
  // bits 0-6 = countdown. When countdown underflows, toggle sign and reload.
  var param = ch.tremorParam;
  if (param === undefined) return;

  var tremorSign = (ch.tremorPos || 0) & 0x80;
  var tremorData = (ch.tremorPos || 0) & 0x7f;

  tremorData--;
  if (tremorData < 0) {
    if (tremorSign === 0x80) {
      tremorSign = 0x00;
      tremorData = param & 0x0f;
    } else {
      tremorSign = 0x80;
      tremorData = param >> 4;
    }
  }

  ch.tremorPos = tremorSign | tremorData;
  if (tremorSign !== 0x80) {
    ch.voloffset = -ch.vol;  // mute during off phase
  }
}

function eff_t0_l(ch, data) {  // set envelope position
  // FT2: only set volume envelope position if volume envelope is enabled
  var flags = ch.inst && ch.inst.env_vol_flags;
  if ((flags & 1) && ch.env_vol) {
    ch.env_vol.tick = data;
  }
  // FT2 bug: checks volEnvFlags & ENV_SUSTAIN, not panEnvFlags & ENV_ENABLED
  if ((flags & 2) && ch.env_pan) {
    ch.env_pan.tick = data;
  }
}

function eff_t0_k(ch, data) {  // key off at tick 0
  if (data === 0) player.keyOff(ch);
}

function eff_t1_k(ch) {  // key off at tick
  if (player.cur_tick === (ch.effectdata & 31)) {
    player.keyOff(ch);
  }
}

function eff_unimplemented() {}

player.effects_t0 = [  // effect functions on tick 0
  null,  // 0, arpeggio does nothing on tick 0 (FT2: dummy)
  eff_t0_1,
  eff_t0_2,
  eff_t0_3,
  eff_t0_4,  // 4
  eff_t0_a,  // 5, same as A on first tick
  eff_t0_a,  // 6, same as A on first tick
  eff_t0_7,  // 7
  eff_t0_8,  // 8
  eff_t0_9,  // 9
  eff_t0_a,  // a
  eff_t0_b,  // b
  eff_t0_c,  // c
  eff_t0_d,  // d
  eff_t0_e,  // e
  eff_t0_f,  // f
  eff_t0_g,  // g
  eff_t0_h,  // h
  eff_unimplemented,  // i
  eff_unimplemented,  // j
  eff_t0_k,  // k
  eff_t0_l,  // l
  eff_unimplemented,  // m
  eff_unimplemented,  // n
  eff_unimplemented,  // o
  eff_t0_p,  // p
  eff_unimplemented,  // q
  eff_t0_r,  // r
  eff_unimplemented,  // s
  eff_t0_t,  // t
  eff_unimplemented,  // u
  eff_unimplemented,  // v
  eff_unimplemented,  // w
  eff_t0_x,  // x
  eff_unimplemented,  // y
  eff_unimplemented,  // z
];

player.effects_t1 = [  // effect functions on tick 1+
  eff_t1_0,
  eff_t1_1,
  eff_t1_2,
  eff_t1_3,
  eff_t1_4,
  eff_t1_5,  // 5
  eff_t1_6,  // 6
  eff_t1_7,  // 7
  null,   // 8
  null,   // 9
  eff_t1_a,  // a
  null,   // b
  null,   // c
  null,   // d
  eff_t1_e,  // e
  null,   // f
  null,  // g
  eff_t1_h,  // h
  eff_unimplemented,  // i
  eff_unimplemented,  // j
  eff_t1_k,  // k
  null,  // l
  eff_unimplemented,  // m
  eff_unimplemented,  // n
  eff_unimplemented,  // o
  eff_t1_p,  // p
  eff_unimplemented,  // q
  eff_t1_r,  // r
  eff_unimplemented,  // s
  eff_t1_t,  // t
  eff_unimplemented,  // u
  eff_unimplemented,  // v
  eff_unimplemented,  // w
  eff_unimplemented,  // x
  eff_unimplemented,  // y
  eff_unimplemented   // z
];

})(window);
