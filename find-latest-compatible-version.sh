#!/bin/sh

INSTALL_DIR="/usr/lib/claude-code"
PACKAGE_NAME="@anthropic-ai/claude-code-linux-x64"
VERSION_PREFIX="${VERSION_PREFIX:-2.1.}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-0}"

BUNDLE_FILE="${INSTALL_DIR}/claude-code.js"
BACKUP_FILE="${INSTALL_DIR}/claude-code.js.before-version-test"
VERSION_LIST="${INSTALL_DIR}/compatible-version-candidates.txt"
RESULT_LOG="${INSTALL_DIR}/compatible-version-test.log"
FAILED_LIST="${INSTALL_DIR}/incompatible-versions.txt"
SUCCESS_FILE="${INSTALL_DIR}/compatible-version.txt"

cd "${INSTALL_DIR}" || exit 1

case "${MAX_ATTEMPTS}" in
    ''|*[!0-9]*)
        echo "[ERROR] MAX_ATTEMPTS must be zero or a positive integer."
        exit 1
        ;;
esac

for required_cmd in node npm cp mv rm grep tee; do
    if ! command -v "${required_cmd}" >/dev/null 2>&1; then
        echo "[ERROR] Required command not found: ${required_cmd}"
        exit 1
    fi
done

if [ ! -f extract.js ]; then
    echo "[ERROR] extract.js was not found in ${INSTALL_DIR}."
    exit 1
fi

rm -f "${VERSION_LIST}"
rm -f "${RESULT_LOG}"
rm -f "${FAILED_LIST}"
rm -f "${SUCCESS_FILE}"
rm -f "${BACKUP_FILE}"

if [ -s "${BUNDLE_FILE}" ]; then
    cp "${BUNDLE_FILE}" "${BACKUP_FILE}" || exit 1
    echo "[INFO] Existing bundle backed up:"
    echo "       ${BACKUP_FILE}"
fi

echo "[INFO] Retrieving available versions from npm..."

if ! npm view "${PACKAGE_NAME}" versions --json |
    node -e '
const fs = require("fs");

const prefix = process.argv[1];
const input = fs.readFileSync(0, "utf8");
const versions = JSON.parse(input);

function parseStableVersion(version) {
    const match = version.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/);

    if (!match) {
        return null;
    }

    return {
        text: version,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3])
    };
}

const sorted = versions
    .filter(version => version.startsWith(prefix))
    .map(parseStableVersion)
    .filter(version => version !== null)
    .sort((a, b) =>
        b.major - a.major ||
        b.minor - a.minor ||
        b.patch - a.patch
    );

for (const version of sorted) {
    console.log(version.text);
}
' "${VERSION_PREFIX}" > "${VERSION_LIST}"; then
    echo "[ERROR] Failed to retrieve or parse the npm version list."

    if [ -s "${BACKUP_FILE}" ]; then
        cp "${BACKUP_FILE}" "${BUNDLE_FILE}"
    fi

    exit 1
fi

if [ ! -s "${VERSION_LIST}" ]; then
    echo "[ERROR] No stable versions matched prefix: ${VERSION_PREFIX}"

    if [ -s "${BACKUP_FILE}" ]; then
        cp "${BACKUP_FILE}" "${BUNDLE_FILE}"
    fi

    exit 1
fi

TOTAL_CANDIDATES="$(wc -l < "${VERSION_LIST}" | tr -d ' ')"

echo "[INFO] Version prefix  : ${VERSION_PREFIX}"
echo "[INFO] Candidate count : ${TOTAL_CANDIDATES}"

if [ "${MAX_ATTEMPTS}" -eq 0 ]; then
    echo "[INFO] Attempt limit   : no limit"
else
    echo "[INFO] Attempt limit   : ${MAX_ATTEMPTS}"
fi

echo "[INFO] Starting from newest stable version."
echo

ATTEMPT=0
SUCCESS_VERSION=""

while IFS= read -r VERSION; do
    if [ -z "${VERSION}" ]; then
        continue
    fi

    ATTEMPT=$((ATTEMPT + 1))

    if [ "${MAX_ATTEMPTS}" -ne 0 ] &&
       [ "${ATTEMPT}" -gt "${MAX_ATTEMPTS}" ]; then
        echo "[INFO] Attempt limit reached."
        break
    fi

    echo "============================================================"
    echo "[INFO] Attempt ${ATTEMPT}: Claude Code ${VERSION}"
    echo "============================================================"

    rm -f "${BUNDLE_FILE}"

    if node extract.js --version "${VERSION}" \
        2>&1 |
        tee "${INSTALL_DIR}/extract-${VERSION}.log"; then

        if [ ! -s "${BUNDLE_FILE}" ]; then
            echo "[ERROR] Extractor exited successfully, but claude-code.js is missing."
            echo "${VERSION}" >> "${FAILED_LIST}"
            continue
        fi

        if ! node --check "${BUNDLE_FILE}" \
            > "${INSTALL_DIR}/syntax-${VERSION}.log" 2>&1; then
            echo "[ERROR] JavaScript syntax validation failed."
            cat "${INSTALL_DIR}/syntax-${VERSION}.log"
            rm -f "${BUNDLE_FILE}"
            echo "${VERSION}" >> "${FAILED_LIST}"
            continue
        fi

        SUCCESS_VERSION="${VERSION}"
        echo "${VERSION}" > "${SUCCESS_FILE}"

        echo
        echo "[OK] Compatible version found: ${VERSION}"
        echo "[OK] Bundle: ${BUNDLE_FILE}"
        ls -lh "${BUNDLE_FILE}"

        break
    else
        echo "[INFO] Version ${VERSION} is not compatible with this extractor."
        rm -f "${BUNDLE_FILE}"
        echo "${VERSION}" >> "${FAILED_LIST}"
    fi

    echo
done < "${VERSION_LIST}"

if [ -n "${SUCCESS_VERSION}" ]; then
    {
        echo "Compatible version: ${SUCCESS_VERSION}"
        echo "Attempts: ${ATTEMPT}"
        echo "Bundle: ${BUNDLE_FILE}"
    } | tee "${RESULT_LOG}"

    echo
    echo "[OK] Latest compatible version in the tested range:"
    echo "     ${SUCCESS_VERSION}"
    echo
    echo "[INFO] Verify the launcher with:"
    echo "       ./claude-qnx --version"

    exit 0
fi

echo
echo "[ERROR] No compatible version was found in the tested range."

rm -f "${BUNDLE_FILE}"

if [ -s "${BACKUP_FILE}" ]; then
    cp "${BACKUP_FILE}" "${BUNDLE_FILE}"

    echo "[INFO] Previous working bundle was restored:"
    echo "       ${BUNDLE_FILE}"
else
    echo "[WARNING] No previous bundle was available to restore."
fi

exit 1
