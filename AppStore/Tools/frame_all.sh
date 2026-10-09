#!/bin/bash
# Frames the App Store screenshots: bezel + Kickoff gradient + caption.
# Reads AppStore/screenshots/<device>/<lang>/, writes AppStore/framed/<device>/<lang>/.
# Needs Pillow for pad.py (PYTHON=… to point at a venv that has it).
#
#   AppStore/Tools/frame_all.sh            # en and pl, every device
#   AppStore/Tools/frame_all.sh pl         # just Polish
#   DEVICES=mac AppStore/Tools/frame_all.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TOOL="$HERE/Tools/frame_screenshot.swift"
PY=${PYTHON:-python3}
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Apple's bezels, kept in the Dutch and Worldward projects.
IPHONE_BEZEL="/Users/mar/Dev/Dutch/Screenshots/Bezels/iPhone 17 Pro Max/iPhone 17 Pro Max - Deep Blue - Portrait.png"
# The only iPad bezel on hand is the A16's, narrower than the 13" iPad Pro, so
# the 13" capture is letterboxed to its shape rather than cropped.
IPAD_BEZEL="/Users/mar/Dev/Dutch/Screenshots/Bezels/iPad A16/iPad (A16) - Silver - Portrait.png"
MAC_BEZEL="/Users/mar/Dev/Worldward/Screenshots/Bezels/Macbook Pro M5/MacBook Pro M5 14-inch Space Black.png"

LANGS=${*:-"en pl"}
DEVICES=${DEVICES:-"iphone ipad mac"}

# src | out | headline | subhead | gradient | tilt | width | offX | offY [| canvas W H typeScale]
frame () {
  local src="$1" out="$2"; shift 2
  swift "$TOOL" "$BEZEL" "$src" "$OUT/$out" "$@" 2>/dev/null
  printf "  %-12s %s\n" "$out" "$(sips -g pixelWidth -g pixelHeight "$OUT/$out" | tail -2 | tr -d ' \n')"
}

for lang in $LANGS; do
  # A caption has to be backed by what is visible in the frame beneath it.
  case "$lang" in
  en)
    H1="A chat you can follow"
    S1="Deleted messages stay readable, and links, emotes and fonts look right"
    H2="Everything in one place"
    S2="Tap the rocket: Apple fonts, text size and every feature as a switch"
    H3="Know who you're talking to"
    S3="Their recent messages, highlight or mute, and private notes in your iCloud"
    H4="Never miss a mention"
    S4="Messages that mention you or your words, collected in one place"
    ;;
  pl)
    H1="Czat, za którym nadążysz"
    S1="Usunięte wiadomości da się przeczytać, a linki, emotki i fonty wyglądają jak trzeba"
    H2="Wszystko w jednym miejscu"
    S2="Stuknij rakietę: fonty Apple, wielkość tekstu i każda funkcja jako przełącznik"
    H3="Wiesz, kto pisze"
    S3="Ostatnie wiadomości, wyróżnianie, wyciszanie i prywatne notatki w twoim iCloud"
    H4="Żadna wzmianka nie ucieknie"
    S4="Wiadomości z twoim nickiem lub słowami zebrane w jednym miejscu"
    ;;
  *) echo "unknown language '$lang'" >&2; exit 1 ;;
  esac

  for device in $DEVICES; do
    case "$device" in
    iphone)
      RAW="$HERE/screenshots/iphone-6.9/$lang"; OUT="$HERE/framed/iphone-6.9/$lang"; BEZEL="$IPHONE_BEZEL"
      mkdir -p "$OUT"; echo "$lang iPhone:"
      frame "$RAW/1-chat.png"  1-chat.png  "$H1" "$S1" gradient-kick   -4 0.92 0.50 0.375
      frame "$RAW/2-panel.png" 2-panel.png "$H2" "$S2" gradient-kick-r  4 0.92 0.50 0.375
      frame "$RAW/3-card.png"  3-card.png  "$H3" "$S3" gradient-kick   -4 0.92 0.50 0.375
      frame "$RAW/4-inbox.png" 4-inbox.png "$H4" "$S4" gradient-kick-r  4 0.92 0.50 0.375
      ;;
    ipad)
      RAW="$HERE/screenshots/ipad-13/$lang"; OUT="$HERE/framed/ipad-13/$lang"; BEZEL="$IPAD_BEZEL"
      mkdir -p "$OUT"; echo "$lang iPad:"
      for n in 1-chat 2-panel 3-card 4-inbox; do "$PY" "$HERE/Tools/pad.py" "$RAW/$n.png" "$TMP/ipad-$n.png" 0.6945; done
      C="2064 2752 1.5"
      frame "$TMP/ipad-1-chat.png"  1-chat.png  "$H1" "$S1" gradient-kick   -2.5 0.86 0.50 0.40 $C
      frame "$TMP/ipad-2-panel.png" 2-panel.png "$H2" "$S2" gradient-kick-r  2.5 0.86 0.50 0.40 $C
      frame "$TMP/ipad-3-card.png"  3-card.png  "$H3" "$S3" gradient-kick   -2.5 0.86 0.50 0.40 $C
      frame "$TMP/ipad-4-inbox.png" 4-inbox.png "$H4" "$S4" gradient-kick-r  2.5 0.86 0.50 0.40 $C
      ;;
    mac)
      RAW="$HERE/screenshots/mac/$lang"; OUT="$HERE/framed/mac/$lang"; BEZEL="$MAC_BEZEL"
      mkdir -p "$OUT"; echo "$lang Mac:"
      for n in 1-chat 2-panel 3-card 4-inbox; do "$PY" "$HERE/Tools/pad.py" "$RAW/$n.png" "$TMP/mac-$n.png" 1.5397 --top; done
      C="2880 1800 1.4"
      frame "$TMP/mac-1-chat.png"  1-chat.png  "$H1" "$S1" gradient-kick   0 0.76 0.50 0.42 $C
      frame "$TMP/mac-2-panel.png" 2-panel.png "$H2" "$S2" gradient-kick-r 0 0.76 0.50 0.42 $C
      frame "$TMP/mac-3-card.png"  3-card.png  "$H3" "$S3" gradient-kick   0 0.76 0.50 0.42 $C
      frame "$TMP/mac-4-inbox.png" 4-inbox.png "$H4" "$S4" gradient-kick-r 0 0.76 0.50 0.42 $C
      ;;
    esac
  done
done
