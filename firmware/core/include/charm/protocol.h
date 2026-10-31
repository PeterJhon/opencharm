#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

// The charm side of packages/protocol: parse what charmd sends, build what the charm sends.
// Both sides are tested against the same JSON fixtures (packages/protocol/fixtures).
namespace charm {

enum class ServerKind {
  Unknown,
  Hello,
  Stt,
  TtsStart,
  TtsSentence,
  TtsStop,
  Llm,
  PairCode,
  Paired,
  Unlocked,
  Locked,
  Revoked,
  Face,
  Progress,
  Ask,
  AskEnd,
  Look,
  Clock,
};

// What the agent is working through (spec 017): a plan line or a tool call, and where it is.
enum class ProgressStatus { Pending, InProgress, Completed, Failed };
struct ProgressEntry {
  std::string text;
  ProgressStatus status = ProgressStatus::Pending;
};

enum class LockReason { Boot, WrongPin, Remote, Blocked };

// The charm's identity (spec 014), sent by charmd before every unlock and whenever it changes.
// Held in memory only: nothing about it is stored on the charm.
struct Look {
  std::string name;
  uint32_t glyph = 0xF4F3EE;   // 0xRRGGBB; never the signal orange
  std::string greeting;        // the line after unlocking; empty = none
  uint32_t sleep_ms = 240000;  // 0 = never sleeps
  bool calm = false;           // calm motion: no glances, squash or voice swell
  int volume = -1;             // the speaker, 0..100; -1 = not sent (an older charmd): keep it
};

struct ServerMessage {
  ServerKind kind = ServerKind::Unknown;
  std::string session_id;
  std::string text;     // stt, tts sentence, face line
  std::string code;     // pair_code
  std::string token;    // paired
  std::string state;    // face
  std::string feeling;  // face: drawn instead of the state's own face, when sent
  std::string id;       // ask, ask_end
  std::string yes;      // ask: the hold label (default ALLOW)
  std::string no;       // ask: the press label (default NO)
  std::string clock;    // clock: the computer's local time, "hh:mm"
  int expires_in = 0;
  int tries_left = -1;  // -1 when absent
  LockReason reason = LockReason::Boot;
  Look look;
  std::vector<ProgressEntry> progress;  // progress: at most 12 lines
  bool accepts_text = false;            // hello: charmd accepts typed text (spec 013)
  bool accepts_battery = false;         // hello: charmd accepts the charm's battery (spec 009)
  bool accepts_speak = false;           // hello: charmd reads a tapped progress line (spec 017)
};

// Returns false for anything that is not a valid message from charmd; never throws.
bool parse_server_message(std::string_view json, ServerMessage& out);

// The commit this core was built from (spec 015), in a source file CMake generates.
extern const char kBuildCommit[];

// What the charm runs, sent in hello (spec 015): kind is "emulator", "desktop" or "board"; version
// is the release identity of what ships it (e.g. "cli@0.2.0"). Empty kind = not sent.
struct Build {
  std::string kind;
  std::string version;
  std::string commit;
};

std::string client_hello(const Build& build = {});
std::string client_listen(bool start, std::string_view session_id);
std::string client_abort(std::string_view session_id, std::string_view reason);
std::string client_unlock(std::string_view pin);
std::string client_answer(std::string_view id, bool yes);
// Typed text from the desktop charm's field (spec 013), answered as text; only to a charmd whose
// hello said `features.text`.
std::string client_text(std::string_view text);
// The charm's battery (spec 009), once unlocked and on change.
std::string client_battery(int percent, bool charging, bool usb);
// One progress line to read aloud (spec 017); only to a charmd whose hello said `features.speak`.
std::string client_speak(std::string_view text);

// Where the board connects (spec 009): the charmd address typed at Wi-Fi setup, as a WebSocket URL.
// Only the scheme, host and port count, so "charm.example.com", "https://charm.example.com" and
// "http://192.168.1.20:8787/ota/" all work: https or no scheme gives wss, http gives ws, and the
// path is always /charm. Anything else (another scheme, a user and password, spaces, a bad port)
// gives an empty string: the charm asks again rather than guessing.
std::string charm_url(std::string_view address);

}  // namespace charm
