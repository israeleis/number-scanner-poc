// Receives scans from the number scanner app: one row per scan in the "scans" sheet, and the two
// images of each scan in a "scan-images" folder next to this spreadsheet.
// Set KEY to any secret word and type the same word in the app's settings.
const KEY = 'change-me'

const COLUMNS = [
  'id', 'createdAt', 'tester', 'outcome', 'chosen', 'actual', 'setup', 'preprocess', 'hardware', 'voting',
  'torch', 'zoom', 'timeToResultMs', 'reads', 'frameReads', 'framesRead', 'framesBlurry', 'sharpness',
  'voteFrames', 'blurThreshold', 'detLimit', 'minConfidence', 'scene', 'notes', 'resolution',
  'cameraSupports', 'hardwareApplied', 'modelLoadMs', 'device', 'appVersion', 'originalImage', 'processedImage',
]

function doGet(e) {
  if (e.parameter.key !== KEY) return reply({ ok: false, error: 'wrong key' })
  return reply({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName() })
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents)
  if (body.key !== KEY) return reply({ ok: false, error: 'wrong key' })
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet()
    const sheet = ss.getSheetByName('scans') || ss.insertSheet('scans')
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(COLUMNS)
      sheet.setFrozenRows(1)
    }
    const r = body.record
    // The app retries until it hears back, so the same scan can arrive twice.
    if (sheet.getRange('A:A').createTextFinder(r.id).matchEntireCell(true).findNext()) {
      return reply({ ok: true, duplicate: true })
    }
    const folder = imagesFolder(ss)
    r.originalImage = saveImage(folder, body.original, r.id + '-original.jpg')
    r.processedImage = saveImage(folder, body.processed, r.id + '-processed.jpg')
    sheet.appendRow(COLUMNS.map(function (c) {
      const v = r[c]
      if (v === null || v === undefined) return ''
      if (Array.isArray(v) && c === 'scene') return v.join(', ')
      return typeof v === 'object' ? JSON.stringify(v) : v
    }))
    return reply({ ok: true })
  } finally {
    lock.releaseLock()
  }
}

function imagesFolder(ss) {
  const parent = DriveApp.getFileById(ss.getId()).getParents().next()
  const found = parent.getFoldersByName('scan-images')
  return found.hasNext() ? found.next() : parent.createFolder('scan-images')
}

function saveImage(folder, base64, name) {
  if (!base64) return ''
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg', name)
  return folder.createFile(blob).getUrl()
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}
