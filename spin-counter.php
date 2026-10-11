<?php
// ================= SETTINGS (edit these) =================
$MAX_SPINS  = 200;                      // total spins allowed, then the wheel closes
$ADMIN_PASS = 'starccafe2026';   // used to view the winners list (see below)
// Prize name, number of slices (more slices = better odds)
$PRIZES = [
  ['فنجان قهوة واحد', 2],
  ['كوبون خصم 30%',   1],
  ['كوبون خصم 10%',   3],
  ['كوبون خصم 5%',    2],
];
// =========================================================

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$FILE  = __DIR__ . '/spin-data.php';
$GUARD = "<?php http_response_code(403); exit; ?>\n"; // keeps the data file private if opened in a browser

function lines_of($content, $guard) {
  $body = (strpos($content, $guard) === 0) ? substr($content, strlen($guard)) : $content;
  return array_values(array_filter(explode("\n", $body), 'strlen'));
}
function out($arr) { echo json_encode($arr, JSON_UNESCAPED_UNICODE); exit; }

$action = $_REQUEST['action'] ?? 'status';

$h = fopen($FILE, 'c+');
if (!$h) { http_response_code(500); out(['ok' => false, 'error' => 'storage']); }
flock($h, LOCK_EX);
$content = stream_get_contents($h);
if ($content === '' || $content === false) $content = $GUARD;
$rows  = lines_of($content, $GUARD);
$count = count($rows);

if ($action === 'status') {
  flock($h, LOCK_UN); fclose($h);
  out(['ok' => true, 'open' => $count < $MAX_SPINS, 'prizes' => $PRIZES]);
}

if ($action === 'spin' && $_SERVER['REQUEST_METHOD'] === 'POST') {
  if ($count >= $MAX_SPINS) { flock($h, LOCK_UN); fclose($h); out(['ok' => false, 'closed' => true]); }

  // weighted random prize
  $total = 0; foreach ($PRIZES as $p) $total += $p[1];
  $r = random_int(1, $total); $index = 0;
  foreach ($PRIZES as $i => $p) { $r -= $p[1]; if ($r <= 0) { $index = $i; break; } }

  // unique 4-character code
  $existing = array_map(function ($l) { $d = json_decode($l, true); return $d['code'] ?? ''; }, $rows);
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  do { $code = ''; for ($i = 0; $i < 4; $i++) $code .= $chars[random_int(0, strlen($chars) - 1)]; }
  while (in_array($code, $existing, true));

  $entry = json_encode(['n' => $count + 1, 'time' => date('c'), 'prize' => $PRIZES[$index][0], 'code' => $code], JSON_UNESCAPED_UNICODE);
  ftruncate($h, 0); rewind($h);
  fwrite($h, $content . $entry . "\n");
  fflush($h); flock($h, LOCK_UN); fclose($h);
  out(['ok' => true, 'index' => $index, 'prize' => $PRIZES[$index][0], 'code' => $code, 'left' => $MAX_SPINS - $count - 1]);
}

// Owner only: open spin-counter.php?action=codes&pass=YOUR_PASSWORD to see every spin and code
if ($action === 'codes' && hash_equals($ADMIN_PASS, $_GET['pass'] ?? '')) {
  flock($h, LOCK_UN); fclose($h);
  out(['total' => $count, 'spins' => array_map(function ($l) { return json_decode($l, true); }, $rows)]);
}

// Owner only: open spin-counter.php?action=reset&pass=YOUR_PASSWORD&confirm=yes to delete all records and restart the count at 0
if ($action === 'reset' && hash_equals($ADMIN_PASS, $_GET['pass'] ?? '')) {
  if (($_GET['confirm'] ?? '') !== 'yes') {
    flock($h, LOCK_UN); fclose($h);
    out(['ok' => false, 'message' => 'Add &confirm=yes to the address to really delete all ' . $count . ' records.']);
  }
  ftruncate($h, 0); rewind($h); fwrite($h, $GUARD); fflush($h);
  flock($h, LOCK_UN); fclose($h);
  out(['ok' => true, 'message' => 'All records deleted. Count is back to 0.', 'deleted' => $count]);
}

flock($h, LOCK_UN); fclose($h);
http_response_code(400);
out(['ok' => false]);
