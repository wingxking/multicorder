#!/usr/bin/env bash
# Two test speeches with different planted words: English "Falcon" and Chinese "斑马".
. "$(dirname "$0")/env.sh"
A_TEXT="Welcome to the Falcon project update. The Falcon budget for next year is 42 million dollars. Our team will hire 18 engineers in Singapore. The beta launch is planned for the second quarter. Customers asked for an offline mode, so we decided to build offline mode first. Falcon will support three new languages at launch."
B_TEXT="欢迎收听斑马协议发布会。斑马协议将于三月七日在柏林正式上线。首批合作伙伴一共有十二家公司。我们的目标是在今年年底之前覆盖五十万名用户。斑马协议的第二个版本会加入离线同步功能。"
say -v "Flo (English (US))" -r 175 -o "$OUT/a.aiff" "$A_TEXT"
say -v "Eddy (Chinese (China mainland))" -o "$OUT/b.aiff" "$B_TEXT"
for x in a b; do afconvert -f WAVE -d LEI16@16000 -c 1 "$OUT/$x.aiff" "$OUT/$x.wav"; rm "$OUT/$x.aiff"; done
ls -l "$OUT"/a.wav "$OUT"/b.wav
