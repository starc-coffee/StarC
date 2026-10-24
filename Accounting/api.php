<?php
/*
 * StarC Billing — records API
 * Keeps invoice records in a file on the website (data/records.jsonl) so every
 * device sees the same records. Put this file in the SAME folder as
 * starc-billing.html, and protect that folder with your username/password.
 *
 * Files created automatically inside ./data :
 *   records.jsonl   one invoice line per row (the main record file)
 *   meta.json       menu, counters
 *   backups/        automatic daily copy (last 30) + safety copy before delete/restore
 */
declare(strict_types=1);

/* ---- optional settings ------------------------------------------------- */
// If your site uses a PHP login (sessions) instead of a folder password, put the
// session variable name that is set after login here, e.g. 'manager_logged_in'.
$SESSION_KEY = '';
// Where the data lives. For extra safety you can point this OUTSIDE your public
// web folder, e.g. '/home/youraccount/starc-data'.
$DATA_DIR = __DIR__ . '/data';
/* ------------------------------------------------------------------------ */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function out(array $a, int $code = 200): void {
    http_response_code($code);
    echo json_encode($a, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(string $msg, int $code = 400): void { out(['ok' => false, 'error' => $msg], $code); }

if ($SESSION_KEY !== '') {
    session_start();
    if (empty($_SESSION[$SESSION_KEY])) fail('auth', 401);
}

/* ---- data folder ------------------------------------------------------- */
if (!is_dir($DATA_DIR)) @mkdir($DATA_DIR, 0750, true);
if (!is_dir($DATA_DIR) || !is_writable($DATA_DIR)) fail('data folder is not writable', 500);
$ht = $DATA_DIR . '/.htaccess';
if (!is_file($ht)) {
    @file_put_contents($ht, "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n");
}
if (!is_file($DATA_DIR . '/index.html')) @file_put_contents($DATA_DIR . '/index.html', '');

$REC  = $DATA_DIR . '/records.jsonl';
$META = $DATA_DIR . '/meta.json';

/* ---- helpers ----------------------------------------------------------- */
function cut($v, int $n): string {
    $s = (string)($v ?? '');
    return function_exists('mb_substr') ? mb_substr($s, 0, $n, 'UTF-8') : substr($s, 0, $n);
}
function num($v) { return is_numeric($v) ? $v + 0 : 0; }

function load_meta(string $f): array {
    $m = is_file($f) ? json_decode((string)file_get_contents($f), true) : null;
    if (!is_array($m)) $m = [];
    return $m + ['seq' => 0, 'epoch' => 1, 'menu' => null, 'ops' => []];
}
function save_meta(string $f, array $m): void {
    $tmp = $f . '.tmp';
    if (file_put_contents($tmp, json_encode($m, JSON_UNESCAPED_UNICODE)) === false) fail('cannot write meta', 500);
    if (!@rename($tmp, $f)) { @copy($tmp, $f); @unlink($tmp); }
}
function clean_row($r): array {
    if (!is_array($r)) $r = [];
    return [
        'ts' => cut($r['ts'] ?? '', 25), 'inv' => cut($r['inv'] ?? '', 40), 'table' => cut($r['table'] ?? '', 40),
        'date' => cut($r['date'] ?? '', 10), 'staff' => cut($r['staff'] ?? '', 80),
        'itemId' => num($r['itemId'] ?? 0), 'en' => cut($r['en'] ?? '', 200), 'ar' => cut($r['ar'] ?? '', 200),
        'price' => num($r['price'] ?? 0), 'qty' => num($r['qty'] ?? 0), 'total' => num($r['total'] ?? 0),
    ];
}
function clean_menu($menu): ?array {
    if (!is_array($menu) || count($menu) > 500) return null;
    $o = [];
    foreach ($menu as $m) {
        if (!is_array($m)) continue;
        $o[] = ['id' => num($m['id'] ?? 0), 'en' => cut($m['en'] ?? '', 200), 'ar' => cut($m['ar'] ?? '', 200), 'price' => num($m['price'] ?? 0)];
    }
    return $o;
}
function snapshot(string $dir, string $rec, string $kind): void {
    if (!is_file($rec) || filesize($rec) === 0) return;
    $bd = $dir . '/backups';
    if (!is_dir($bd)) @mkdir($bd, 0750, true);
    if ($kind === 'daily') {
        $dest = $bd . '/daily-' . date('Y-m-d') . '.jsonl';
        if (is_file($dest)) return;
    } else {
        $dest = $bd . '/pre-' . date('Ymd-His') . '.jsonl';
    }
    @copy($rec, $dest);
    foreach (['daily-' => 30, 'pre-' => 20] as $prefix => $keep) {
        $files = glob($bd . '/' . $prefix . '*.jsonl') ?: [];
        sort($files);
        while (count($files) > $keep) @unlink(array_shift($files));
    }
}

/* ---- lock -------------------------------------------------------------- */
$lock = fopen($DATA_DIR . '/lock', 'c');
if (!$lock) fail('cannot lock', 500);
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/* ---- GET: read records (only what the device has not seen yet) ---------- */
if ($method === 'GET') {
    flock($lock, LOCK_SH);
    $m = load_meta($META);
    $full  = ((int)($_GET['epoch'] ?? 0)) !== (int)$m['epoch'];
    $since = $full ? 0 : (int)($_GET['since'] ?? 0);
    $rows = [];
    if (is_file($REC) && ($h = fopen($REC, 'r'))) {
        while (($line = fgets($h)) !== false) {
            $line = trim($line);
            if ($line === '') continue;
            $r = json_decode($line, true);
            if (is_array($r) && ($r['id'] ?? 0) > $since) $rows[] = $r;
        }
        fclose($h);
    }
    out(['ok' => true, 'epoch' => (int)$m['epoch'], 'seq' => (int)$m['seq'], 'full' => $full, 'records' => $rows, 'menu' => $m['menu']]);
}

if ($method !== 'POST') fail('method not allowed', 405);

/* ---- POST: change records ---------------------------------------------- */
// Requiring a JSON content-type blocks cross-site form posts.
if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') === false) fail('json required', 415);
$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 8 * 1024 * 1024) fail('request too large', 413);
$in = json_decode($raw, true);
if (!is_array($in)) fail('invalid json');
$op   = (string)($in['op'] ?? '');
$opId = cut($in['opId'] ?? '', 64);
if ($opId === '') fail('opId required');

flock($lock, LOCK_EX);
$m = load_meta($META);

if (in_array($opId, $m['ops'], true)) {            // already applied (e.g. a retry)
    out(['ok' => true, 'dup' => true, 'epoch' => (int)$m['epoch'], 'seq' => (int)$m['seq']]);
}

if ($op === 'add') {
    $rows = $in['rows'] ?? null;
    if (!is_array($rows) || count($rows) === 0 || count($rows) > 2000) fail('bad rows');
    snapshot($DATA_DIR, $REC, 'daily');
    $buf = '';
    foreach ($rows as $r) {
        $row = ['id' => ++$m['seq']] + clean_row($r);
        $buf .= json_encode($row, JSON_UNESCAPED_UNICODE) . "\n";
    }
    if (file_put_contents($REC, $buf, FILE_APPEND) === false) fail('cannot write records', 500);

} elseif ($op === 'delete') {
    $inv = cut($in['inv'] ?? '', 40);
    if ($inv === '') fail('inv required');
    snapshot($DATA_DIR, $REC, 'pre');
    $tmp = $REC . '.tmp';
    $w = fopen($tmp, 'w');
    if (is_file($REC) && ($h = fopen($REC, 'r'))) {
        while (($line = fgets($h)) !== false) {
            $r = json_decode(trim($line), true);
            if (is_array($r) && ($r['inv'] ?? '') !== $inv) fwrite($w, trim($line) . "\n");
        }
        fclose($h);
    }
    fclose($w);
    if (!@rename($tmp, $REC)) { @copy($tmp, $REC); @unlink($tmp); }
    $m['epoch']++;

} elseif ($op === 'replace') {                      // clears all records (restore starts with this)
    snapshot($DATA_DIR, $REC, 'pre');
    file_put_contents($REC, '');
    $m['epoch']++;
    if (isset($in['menu'])) { $mm = clean_menu($in['menu']); if ($mm !== null) $m['menu'] = $mm; }

} elseif ($op === 'menu') {
    $mm = clean_menu($in['menu'] ?? null);
    if ($mm === null) fail('bad menu');
    $m['menu'] = $mm;

} else {
    fail('unknown op');
}

$m['ops'][] = $opId;
if (count($m['ops']) > 1000) $m['ops'] = array_slice($m['ops'], -1000);
save_meta($META, $m);
out(['ok' => true, 'epoch' => (int)$m['epoch'], 'seq' => (int)$m['seq']]);
