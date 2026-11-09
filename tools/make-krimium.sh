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

echo "*** uBlock0.krimium: Package done."
