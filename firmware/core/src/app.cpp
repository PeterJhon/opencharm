#include "charm/app.h"

#include <cstdio>
#include <cstring>

#include "generated/faces.h"

namespace charm {
namespace {

constexpr uint8_t kDimPercent = 20;
constexpr uint8_t kFullPercent = 100;
constexpr uint32_t kQuickTapsMs = 2000;  // three taps within this = dizzy
// Up to about a second of 60 ms frames before a hold is confirmed (it takes 200 ms): enough for a
// late tick, bounded for the board's memory.
constexpr size_t kPrerollFrames = 16;
// Typed text charmd accepts (spec 001): not blank, at most 2,000 characters (code points).
constexpr size_t kMaxTypedChars = 2000;
// A text reply kept for the scrollable report; far more than a screenful, bounded for memory.
constexpr size_t kMaxReportBytes = 32 * 1024;

bool sendable(std::string_view text) {
  size_t chars = 0;
  bool blank = true;
  for (unsigned char c : text) {
    if ((c & 0xC0) != 0x80) ++chars;  // a character starts at every byte that isn't a continuation
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') blank = false;
  }
  return !blank && chars <= kMaxTypedChars;
}

// Collect a reply that is read, not spoken; a sentence per line. Past the cap the rest is cut on a
// character boundary and marked with "…", so a runaway reply stays bounded for the board's memory.
void append_report(std::string& report, std::string_view text) {
  if (report.size() >= kMaxReportBytes) return;
  if (!report.empty()) report += '\n';
  if (text.empty()) return;  // a blank line, as the reply was written
  size_t room = kMaxReportBytes - report.size();
  if (text.size() <= room) {
    report += text;
    return;
  }
  size_t cut = room;
  while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80) --cut;
  report.append(text.substr(0, cut));
  report += "…";
}

struct Reaction {
  const char* face;
  const char* line;
};
// What a poke gets back; never the same twice in a row.
constexpr Reaction kTapReactions[] = {
    {"cute", "Hehe."}, {"wink", ""}, {"joy", "Hey!"}, {"surprised", "Boop."}, {"loved", ""},
};

// charmd speaks in agent states ("thinking", "needs_you"); the screen draws faces ("thinking",
// "ask").
std::string face_for(std::string_view state_or_face) {
  for (const auto& state : design::kStates)
    if (state_or_face == state.id) return state.face;
  return std::string(state_or_face);
}

}  // namespace

App::App(Hal& hal, View& view, AppOptions options)
    : hal_(hal),
      view_(view),
      options_(options),
      rng_(options.seed ? options.seed : 1),
      sleep_after_ms_(options.sleep_after_ms) {}

uint32_t App::next_random() {
  rng_ = rng_ * 1664525u + 1013904223u;
  return rng_ >> 8;
}

void App::react(const char* face, const char* line, uint32_t ms, uint32_t now,
                const char* then_face, uint32_t then_ms) {
  react_until_ = now + ms;
  then_face_ = then_face;
  then_ms_ = then_ms;
  if (!status_open_ && !progress_open_ && !report_open_) view_.show_face(face, line);
}

void App::show_current() {
  if (screen_ != Screen::Face || asking_ || status_open_ || progress_open_ || report_open_) return;
  if (speaking_) return;  // the speech layout is on screen
  view_.show_face(asleep_ ? "sleepy" : std::string_view(face_), asleep_ ? "" : line_);
}

// A key press or a tap wakes a sleeping charm with a start; returns whether it was asleep.
bool App::wake(uint32_t now) {
  if (!asleep_) return false;
  asleep_ = false;
  show_battery_for_a_moment(now);
  react("surprised", "", 500, now, "happy", 900);
  return true;
}

void App::start(uint32_t now) {
  booting_ = true;
  boot_until_ = now + options_.boot_ms;
  last_activity_ = now;
  screen_ = Screen::Connecting;
  connecting_line_ = "Connecting…";
  view_.show_boot();
}

void App::render() {
  if (booting_) return;
  switch (screen_) {
    case Screen::Boot:
      view_.show_boot();
      break;
    case Screen::Connecting:
      view_.show_connecting(connecting_line_);
      break;
    case Screen::Pairing:
      view_.show_pairing(pair_code_);
      break;
    case Screen::Pin:
      view_.show_pin(pin_tries_, pin_wrong_);
      break;
    case Screen::Blocked:
      view_.show_blocked();
      break;
    case Screen::Face:
      view_.show_face(face_, line_);
      break;
  }
}

void App::go(Screen screen) {
  // Leaving the face lets go of the key: its release may come on another screen, where it isn't
  // seen, and a hold must never carry over (it would start a talk with the key up). The mic stops.
  if (screen != Screen::Connecting) setup_key_at_ = 0;
  if (screen != Screen::Face) {
    status_open_ = false;
    progress_open_ = false;
    progress_.clear();
    heard_.clear();
    report_.clear();
    report_open_ = false;
    report_hidden_ = false;
    report_cancelled_ = false;
    if (battery_show_ != BatteryShow::Hidden) {
      battery_show_ = BatteryShow::Hidden;
      view_.set_battery(status_.battery, BatteryShow::Hidden);
    }
    end_talk(false);
    key_down_ = false;
    key_answered_ = false;
  }
  screen_ = screen;
  render();
}

void App::set_needs_you(bool on) {
  if (on == needs_you_) return;
  needs_you_ = on;
  view_.set_needs_you(on);
}

void App::tick(uint32_t now) {
  if (booting_ && now >= boot_until_) {
    booting_ = false;
    render();
  }
  if (key_down_ && screen_ == Screen::Face && now - key_down_at_ >= options_.hold_ms) {
    // On a question, a hold is "yes", answered at once; it never opens the mic.
    if (asking_ && !key_answered_) {
      key_answered_ = true;
      answer(true);
    } else if (!talking_ && !key_answered_) {
      begin_talk();
    }
  }
  if (setup_key_at_ != 0 && screen_ == Screen::Connecting &&
      now - setup_key_at_ >= options_.setup_hold_ms) {
    setup_key_at_ = 0;
    hal_.open_setup();
  }
  if (react_until_ != 0 && now >= react_until_) {
    react_until_ = 0;
    if (then_face_ && screen_ == Screen::Face && !speaking_ && !asking_) {
      const char* next = then_face_;
      then_face_ = nullptr;
      react(next, "", then_ms_, now);
    } else {
      then_face_ = nullptr;
      show_current();
    }
  }
  if (status_open_ && now >= status_until_) close_status();
  if (progress_open_ && now >= progress_until_) close_progress();
  // A report stays until a press or a tap, but not forever: falling asleep puts it away. It doesn't
  // dim while it is read (scrolling isn't activity the App hears), so it stays legible.
  if (screen_ == Screen::Face && report_open_ && !talking_ && !key_down_ && sleep_after_ms_ != 0 &&
      now - last_activity_ >= sleep_after_ms_) {
    close_report();
  }
  if (screen_ == Screen::Face && !asleep_ && !talking_ && !speaking_ && !key_down_ && !asking_ &&
      !status_open_ && !progress_open_ && !report_open_ && react_until_ == 0 &&
      sleep_after_ms_ != 0 && now - last_activity_ >= sleep_after_ms_) {
    asleep_ = true;
    view_.show_face("sleepy", "");
  }
  if (screen_ == Screen::Face && !dimmed_ && !talking_ && !speaking_ && !key_down_ && !asking_ &&
      !progress_open_ && !report_open_ && now - last_activity_ >= options_.dim_after_ms) {
    dimmed_ = true;
    hal_.set_brightness(kDimPercent);
  }
  update_battery(now);
  // The screen's clock runs between charmd's messages: a missed minute never freezes it.
  if (clock_minutes_ >= 0) {
    const int minutes = (clock_minutes_ + int((now - clock_synced_at_) / 60000u)) % 1440;
    char text[6];
    std::snprintf(text, sizeof text, "%02d:%02d", minutes / 60, minutes % 60);
    if (clock_text_ != text) {
      clock_text_ = text;
      view_.set_clock(clock_text_);
    }
  }
  view_.tick(now);
}

void App::activity(uint32_t now) {
  last_activity_ = now;
  if (dimmed_) {
    dimmed_ = false;
    hal_.set_brightness(kFullPercent);
  }
}

void App::answer(bool yes) {
  hal_.send_text(client_answer(ask_id_, yes));
  end_ask();
}

void App::end_ask() {
  if (!asking_) return;
  asking_ = false;
  ask_id_.clear();
  // A key already going down was meant for the question: its hold or press does nothing more.
  key_answered_ = key_down_;
  set_needs_you(face_ == "ask");
  if (screen_ != Screen::Face) return;
  if (speaking_) {
    view_.speech_start();
    if (!speech_line_.empty()) view_.speech_line(speech_line_);
  } else if (report_hidden_ && !report_.empty()) {
    report_hidden_ = false;
    report_open_ = true;
    view_.show_report(report_);
  } else {
    report_hidden_ = false;
    view_.show_face(face_, line_);
  }
}

void App::on_connected(uint32_t) { hal_.send_text(client_hello(options_.build)); }

void App::on_disconnected(uint32_t now) { on_offline("Can't reach charmd", now); }

void App::on_offline(std::string_view line, uint32_t) {
  battery_reported_known_ = false;  // the next charmd hears it again
  can_battery_ = false;             // if its hello offers it
  asking_ = false;
  can_type_ = false;  // the next charmd says again in its hello
  can_speak_ = false;
  end_talk(false);
  if (speaking_) stop_speech(false);
  set_needs_you(false);
  connecting_line_ = std::string(line);
  go(Screen::Connecting);
}

void App::on_text(std::string_view json, uint32_t now) {
  ServerMessage message;
  if (parse_server_message(json, message)) handle(message, now);
}

void App::handle(const ServerMessage& m, uint32_t now) {
  switch (m.kind) {
    case ServerKind::Hello:
      session_id_ = m.session_id;
      can_type_ = m.accepts_text;
      can_battery_ = m.accepts_battery;
      can_speak_ = m.accepts_speak;
      break;
    case ServerKind::PairCode:
      pair_code_ = m.code;
      go(Screen::Pairing);
      break;
    case ServerKind::Paired:
      hal_.store_set("token", m.token);
      break;
    case ServerKind::Locked:
      asking_ = false;
      end_talk(false);
      if (speaking_) stop_speech(false);
      set_needs_you(false);
      activity(now);
      if (m.reason == LockReason::Blocked) {
        go(Screen::Blocked);
      } else {
        pin_tries_ = m.tries_left;
        pin_wrong_ = m.reason == LockReason::WrongPin;
        go(Screen::Pin);
      }
      break;
    case ServerKind::Unlocked:
      face_ = "neutral";
      line_.clear();
      heard_.clear();
      progress_.clear();
      progress_open_ = false;
      clear_report();
      asleep_ = false;
      activity(now);
      go(Screen::Face);
      battery_reported_known_ = false;
      report_battery();
      react("happy", greeting_.c_str(), options_.greet_ms, now);
      break;
    case ServerKind::Look:
      // Applies at once, on any screen: charmd sends it right before unlocking.
      greeting_ = m.look.greeting;
      sleep_after_ms_ = m.look.sleep_ms;
      calm_ = m.look.calm;
      view_.set_look(m.look.glyph, m.look.calm);
      if (m.look.volume >= 0) hal_.set_volume(uint8_t(m.look.volume));
      break;
    case ServerKind::Revoked:
      asking_ = false;
      end_talk(false);
      hal_.store_erase("token");
      connecting_line_ = "Pairing again…";
      go(Screen::Connecting);
      hal_.reconnect();
      break;
    case ServerKind::Progress:
      if (screen_ != Screen::Face) break;
      activity(now);
      progress_ = m.progress;
      if (progress_.empty()) {
        // The turn is over: the status screen's gesture comes back.
        clear_progress();
        break;
      }
      progress_until_ = now + options_.progress_ms;
      if (progress_open_) view_.show_progress(progress_, heard_);
      break;
    case ServerKind::Face:
      if (screen_ != Screen::Face) break;
      activity(now);
      // A real agent state (a new turn, a failure, "it needs you") outranks the last reply's
      // report.
      if (m.state != "idle") clear_report();
      // A new turn starts with nothing to show; its own progress follows. The turn's end sends an
      // empty progress list, so the page doesn't linger over the finished face.
      if (m.state == "thinking") {
        clear_progress();
        heard_.clear();  // the new turn's STT follows
      }
      face_ = m.feeling.empty() ? face_for(m.state) : m.feeling;
      line_ = m.text;
      if (asking_) break;  // the question stays on screen; the face comes back after it
      asleep_ = false;
      set_needs_you(m.state == "needs_you");
      // A real agent state (thinking, a failure, "needs you") or a feeling shows at once; only the
      // plain idle face waits for a reaction (a greeting, a poke, being pleased) to finish.
      if (m.state != "idle" || !m.feeling.empty()) stop_reacting();
      // "It needs you" outranks the status and progress screens: the ring comes with the face
      // that says why.
      if (m.state == "needs_you") {
        status_open_ = false;
        progress_open_ = false;
      }
      if (!speaking_ && !key_down_ && react_until_ == 0 && !status_open_ && !progress_open_ &&
          !report_open_)
        view_.show_face(face_, line_);
      break;
    case ServerKind::Ask:
      if (screen_ != Screen::Face) break;
      activity(now);
      stop_reacting();
      asleep_ = false;
      // A talk in progress is dropped, not sent: half a sentence shouldn't become a turn.
      if (talking_) {
        end_talk(false);
        hal_.send_text(client_abort(session_id_, "ask"));
      } else if (capturing_) {
        end_talk(false);
      }
      status_open_ = false;    // a question matters more than the status screen
      progress_open_ = false;  // and more than the progress page
      if (report_open_) {      // and more than the last reply's report, which comes back after it
        report_open_ = false;
        report_hidden_ = true;
      }
      asking_ = true;
      key_answered_ = key_down_;  // a hold already in progress isn't an answer
      ask_id_ = m.id;
      ask_text_ = m.text;
      ask_yes_ = m.yes;
      ask_no_ = m.no;
      set_needs_you(true);
      view_.show_decision(ask_text_, ask_yes_, ask_no_);
      break;
    case ServerKind::AskEnd:
      if (asking_ && m.id == ask_id_) end_ask();
      break;
    case ServerKind::TtsStart:
      if (screen_ != Screen::Face) break;
      activity(now);
      speaking_ = true;
      status_open_ = false;
      progress_open_ = false;  // speech takes the screen; holding the face brings the list back
      stop_reacting();
      asleep_ = false;
      speech_line_.clear();
      // A new reply makes way for the last one's report; this one is collected to keep.
      report_.clear();
      report_open_ = false;
      report_hidden_ = false;
      report_cancelled_ = false;
      tts_audio_ = false;
      if (!asking_) view_.speech_start();
      break;
    case ServerKind::TtsSentence:
      if (!speaking_) break;
      speech_line_ = m.text;
      append_report(report_, m.text);
      if (!asking_) view_.speech_line(m.text);
      break;
    case ServerKind::TtsStop:
      if (!speaking_) break;
      speaking_ = false;
      speech_line_.clear();
      if (!tts_audio_ && !report_cancelled_ && !report_.empty()) {
        // Read, not spoken: the whole reply stays on a page that scrolls, until a press or a tap.
        // While a question has the screen, it waits and comes back when the question is answered.
        if (asking_) {
          report_hidden_ = true;
        } else {
          report_open_ = true;
          view_.show_report(report_);
        }
      } else if (!asking_) {
        view_.speech_end();
        react("happy", "", options_.pleased_ms, now);  // pleased it could help
      }
      report_cancelled_ = false;
      tts_audio_ = false;
      break;
    case ServerKind::Stt:
      // What the person said (spec 003): a short line while the agent starts, and the top of the
      // progress page for the rest of the turn. Never spoken.
      if (screen_ != Screen::Face || m.text.empty()) break;
      activity(now);
      heard_ = m.text;
      if (asking_ || speaking_ || status_open_) break;
      if (progress_open_) {
        view_.show_progress(progress_, heard_);
        break;
      }
      line_ = "You · " + heard_;
      view_.show_face(face_, line_);
      break;
    case ServerKind::Clock: {
      // The computer's local time; the charm shows it and keeps it ticking between messages.
      int hours = (m.clock[0] - '0') * 10 + (m.clock[1] - '0');
      int minutes = (m.clock[3] - '0') * 10 + (m.clock[4] - '0');
      clock_minutes_ = hours * 60 + minutes;
      clock_synced_at_ = now;
      clock_text_ = m.clock;
      view_.set_clock(clock_text_);
      break;
    }
    case ServerKind::Llm:
    case ServerKind::Unknown:
      break;
  }
}

void App::on_audio(const uint8_t* data, size_t size) {
  if (!speaking_) return;
  // Audio means this reply was spoken, not only read: it ends on the face, not as a report.
  tts_audio_ = true;
  if (screen_ == Screen::Face) hal_.play_audio(data, size);
}

void App::on_mic_frame(const uint8_t* data, size_t size) {
  // The mic rule: the mic is on only while the key is down, and audio leaves the charm only once
  // that is a hold (a talk); until then it waits in the pre-roll, and a press throws it away.
  if (!key_down_ || screen_ != Screen::Face) return;
  if (talking_) {
    hal_.send_audio(data, size);
  } else if (capturing_ && preroll_.size() < kPrerollFrames) {
    preroll_.emplace_back(data, data + size);
  }
}

void App::on_key(bool down, uint32_t now) {
  bool was_dimmed = dimmed_;
  activity(now);
  if (screen_ == Screen::Connecting) {
    // Not connected: holding the key long enough opens Wi-Fi setup (to fix the network or charmd's
    // address); there's nothing to talk to.
    setup_key_at_ = down ? (now == 0 ? 1 : now) : 0;
    return;
  }
  if (screen_ != Screen::Face) return;
  if (down) {
    if (key_down_) return;  // already down (two inputs for one key): nothing new
    key_down_ = true;
    key_down_at_ = now;
    key_answered_ = false;
    show_battery_for_a_moment(now);
    update_battery(now);
    if (status_open_ || progress_open_) {
      // This press only closes the screen: no talk, no stop, nothing else.
      key_answered_ = true;
      if (status_open_) close_status();
      if (progress_open_) close_progress();
      return;
    }
    // A report is read-only: a press dismisses it, and if the key stays down it talks as usual.
    if (report_open_) close_report();
    if (!asking_) {
      wake(now);
      stop_reacting();
      if (!calm_) view_.squish();
      view_.show_face("listening", "");
      // Listen from key-down, so a quick talker's first word is kept. Not while it speaks: that
      // press is a stop, and the mic would hear the charm itself.
      if (!speaking_ && !talking_) {
        capturing_ = true;
        preroll_.clear();
        hal_.mic_start();
      }
    }
    return;
  }
  if (!key_down_) return;
  key_down_ = false;
  if (capturing_) end_talk(false);  // a press: its audio is dropped, nothing was sent
  if (key_answered_) {
    key_answered_ = false;
    return;
  }
  if (asking_) {
    answer(false);
    return;
  }
  if (talking_) {
    end_talk(true);
    return;
  }
  // A short press: stop speech, dismiss a line, or just wake the screen.
  if (speaking_) {
    stop_speech(true);
  } else if (!was_dimmed) {
    line_.clear();
    if (face_ == "oops" || face_ == "ask") {
      face_ = "neutral";
      set_needs_you(false);
    }
  }
  view_.show_face(face_, line_);
}

void App::on_touch_face(uint32_t now) {
  bool was_dimmed = dimmed_;
  activity(now);
  if (was_dimmed) show_battery_for_a_moment(now);  // a person woke it
  if (status_open_) {
    close_status();
    return;
  }
  if (progress_open_) {
    close_progress();
    return;
  }
  if (report_open_) {
    close_report();
    return;
  }
  if (screen_ != Screen::Face || speaking_ || key_down_ || asking_) return;
  if (wake(now) || was_dimmed) return;  // the first touch only wakes it
  taps_[0] = taps_[1];
  taps_[1] = taps_[2];
  taps_[2] = now == 0 ? 1 : now;
  if (taps_[0] != 0 && taps_[2] - taps_[0] <= kQuickTapsMs) {
    taps_[0] = taps_[1] = taps_[2] = 0;
    react("dizzy", "Whoa…", 2000, now);
    return;
  }
  constexpr int kCount = int(sizeof(kTapReactions) / sizeof(kTapReactions[0]));
  int pick = int(next_random() % kCount);
  if (pick == last_tap_reaction_) pick = (pick + 1) % kCount;
  last_tap_reaction_ = pick;
  react(kTapReactions[pick].face, kTapReactions[pick].line, options_.react_ms, now);
}

void App::on_mic_level(float level) {
  if (talking_) view_.set_voice_level(level < 0 ? 0 : level > 1 ? 1 : level);
}

App::Typed App::on_typed(std::string_view text, uint32_t now) {
  // Not connected and unlocked yet: not now (charmd's hello hasn't said whether it takes text).
  if (screen_ != Screen::Face) return Typed::Busy;
  if (!can_type_) return Typed::Unsupported;
  if (asking_ || talking_ || key_down_ || !sendable(text)) return Typed::Busy;
  activity(now);
  if (speaking_) stop_speech(true);
  stop_reacting();
  line_.clear();
  hal_.send_text(client_text(text));
  return Typed::Sent;
}

void App::on_pin_entered(std::string_view pin, uint32_t now) {
  activity(now);
  if (screen_ == Screen::Pin) hal_.send_text(client_unlock(pin));
}

void App::begin_talk() {
  if (speaking_) stop_speech(true);
  talking_ = true;
  line_.clear();
  if (capturing_) {
    capturing_ = false;  // the mic has been on since key-down
  } else {
    hal_.mic_start();
  }
  hal_.send_text(client_listen(true, session_id_));
  for (const auto& frame : preroll_) hal_.send_audio(frame.data(), frame.size());
  preroll_.clear();
}

void App::end_talk(bool tell_server) {
  if (capturing_) {
    // Never became a talk: drop what was kept; the server never heard of it.
    capturing_ = false;
    preroll_.clear();
    hal_.mic_stop();
    return;
  }
  if (!talking_) return;
  talking_ = false;
  view_.set_voice_level(0);
  hal_.mic_stop();
  if (tell_server) hal_.send_text(client_listen(false, session_id_));
}

void App::stop_speech(bool tell_server) {
  speaking_ = false;
  report_cancelled_ = true;  // what was read so far isn't kept when the reply is stopped
  report_.clear();
  if (tell_server) hal_.send_text(client_abort(session_id_, "key_pressed"));
  hal_.stop_audio();
  view_.speech_end();
}

void App::on_status(const Status& status, uint32_t now) {
  status_ = status;
  status_.build = options_.build;
  report_battery();
  if (status_open_) view_.show_status(status_);
  update_battery(now);
}

void App::on_touch_hold(uint32_t now) {
  bool was_dimmed = dimmed_;
  activity(now);
  if (was_dimmed) show_battery_for_a_moment(now);  // a person woke it
  if (screen_ != Screen::Face || speaking_ || talking_ || key_down_ || asking_) return;
  if (wake(now) || was_dimmed) return;  // the first touch only wakes it
  stop_reacting();
  // While the agent works, the same hold opens what it is doing; the status screen keeps its
  // gesture whenever there is no progress to show (spec 017).
  if (!progress_.empty()) {
    progress_open_ = true;
    progress_until_ = now + options_.progress_ms;
    update_battery(now);  // hidden on the page, as on the status screen
    view_.show_progress(progress_, heard_);
    return;
  }
  status_open_ = true;
  status_until_ = now + options_.status_ms;
  update_battery(now);  // hidden first: the status screen shows it in large type
  view_.show_status(status_);
}

// A line tapped on the progress page: charmd reads it with the turn's own voice; the agent keeps
// working. Only a charmd that offered `features.speak` gets the message (an older one would close
// the connection on it).
void App::on_progress_tap(std::string_view text, uint32_t now) {
  if (!progress_open_ || screen_ != Screen::Face || !can_speak_) return;
  if (text.empty() || text.size() > 200) return;
  activity(now);
  hal_.send_text(client_speak(text));
}

// charmd hears the battery once the face is unlocked and on every change (spec 009): before that
// it would answer "locked". Only a charmd that offers it in its hello (an older one would close the
// connection on a message it doesn't know); a charm without a battery says nothing.
void App::report_battery() {
  const Battery& b = status_.battery;
  if (b.percent == kUnknown || screen_ != Screen::Face || !can_battery_) return;
  if (battery_reported_known_ && b == battery_reported_) return;
  battery_reported_ = b;
  battery_reported_known_ = true;
  hal_.send_text(client_battery(b.percent, b.charging, b.usb));
}

void App::close_status() {
  if (!status_open_) return;
  status_open_ = false;
  if (report_open_) {  // opened over a report: the report is still there to read
    view_.show_report(report_);
    return;
  }
  view_.show_face(asleep_ ? "sleepy" : std::string_view(face_), asleep_ ? "" : line_);
}

void App::close_progress() {
  if (!progress_open_) return;
  progress_open_ = false;
  if (report_open_) {
    view_.show_report(report_);
    return;
  }
  view_.show_face(asleep_ ? "sleepy" : std::string_view(face_), asleep_ ? "" : line_);
}

void App::clear_progress() {
  progress_.clear();
  close_progress();
}

// The report page: a press or a tap puts it away and the face comes back. Its text is dropped with
// it (the next reply collects its own).
void App::close_report() {
  report_hidden_ = false;
  if (!report_open_) return;
  report_open_ = false;
  report_.clear();
  view_.show_face(asleep_ ? "sleepy" : std::string_view(face_), asleep_ ? "" : line_);
}

// The report no longer belongs on screen (a new turn, a lock), without drawing: the caller shows
// what comes next.
void App::clear_report() {
  report_.clear();
  report_open_ = false;
  report_hidden_ = false;
  report_cancelled_ = false;
}

// Hidden at rest; the level for a moment after waking or a key press, and the whole time on USB;
// a marker that stays while low. Only on the face, and never over the status screen.
void App::update_battery(uint32_t now) {
  const Battery& b = status_.battery;
  BatteryShow show = BatteryShow::Hidden;
  if (b.percent != kUnknown && screen_ == Screen::Face && !status_open_ && !progress_open_ &&
      !booting_) {
    if (b.usb || now < battery_until_)
      show = BatteryShow::Level;
    else if (b.percent < options_.battery_low)
      show = BatteryShow::Low;
  }
  if (show == battery_show_ && (show == BatteryShow::Hidden || b == battery_shown_)) return;
  battery_show_ = show;
  battery_shown_ = b;
  view_.set_battery(b, show);
}

std::string App::token() const { return hal_.store_get("token"); }

}  // namespace charm
