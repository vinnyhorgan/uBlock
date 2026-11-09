#!/usr/bin/env bash
#
# uBlock Origin for krimium (github.com/vinnyhorgan/krimium): the Chromium
# build, with platform/krimium on top. krimium serves the result to a hidden
# web view as uBO's background page.
#
# This script assumes a linux environment

set -e

echo "*** uBlock0.krimium: Creating package"

DES=dist/build/uBlock0.krimium
rm -rf $DES
mkdir -p $DES

echo "*** uBlock0.krimium: Copying common files"
bash ./tools/copy-common-files.sh $DES

echo "*** uBlock0.krimium: Copying chromium-specific files"
cp platform/chromium/*.js   $DES/js/

echo "*** uBlock0.krimium: Copying krimium-specific files"
cp platform/krimium/*.js    $DES/js/
cp platform/krimium/*.html  $DES/
cp platform/krimium/*.json  $DES/

echo "*** uBlock0.krimium: Generating meta..."
python3 tools/make-chromium-meta.py $DES/

# krimium's first lists: uBO's own, and what a careful Firefox user adds to
# them, which is what krimium means by uBO "on the best settings". These are
# only the lists selected the first time uBO starts: the dashboard changes
# them as anywhere else.
echo "*** uBlock0.krimium: Selecting the first lists"
python3 - "$DES/assets/assets.json" <<'EOF2'
import json, sys
path = sys.argv[1]
on = [
    'adguard-spyware-url',      # AdGuard/uBO – URL Tracking Protection
    'curben-phishing',          # Phishing URL Blocklist
    'block-lan',                # Block Outsider Intrusion into LAN
    'fanboy-cookiemonster',     # EasyList – Cookie Notices
    'ublock-cookies-easylist',  # uBlock filters – Cookie Notices
    'ublock-annoyances',        # uBlock filters – Annoyances
    'ITA-0',                    # EasyList Italy
]
with open(path) as f:
    assets = json.load(f)
for key in on:
    assets[key].pop('off', None)
with open(path, 'w') as f:
    json.dump(assets, f, indent=4, ensure_ascii=False)
    f.write('\n')
EOF2

echo "*** uBlock0.krimium: Package done."
