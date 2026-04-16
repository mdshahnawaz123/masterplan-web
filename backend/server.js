const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xlsx = require('xlsx');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/', limits: { fileSize: 200 * 1024 * 1024 } });

// ──────────────────────────────────────────────────────────────
//  APS CONFIG
// ──────────────────────────────────────────────────────────────
const APS_BASE    = 'https://developer.api.autodesk.com';
const CLIENT_ID   = process.env.APS_CLIENT_ID  || '';
const CLIENT_SECRET = process.env.APS_CLIENT_SECRET || '';
const BUCKET_KEY  = (process.env.APS_BUCKET_KEY || 'masterplan-dwg-bucket').toLowerCase();

const apsConfigured = () => CLIENT_ID && CLIENT_SECRET;

// ──────────────────────────────────────────────────────────────
//  APS AUTH
// ──────────────────────────────────────────────────────────────
async function getToken(scopes = ['bucket:create','bucket:read','data:read','data:write','data:create']) {
  const res = await axios.post(
    `${APS_BASE}/authentication/v2/token`,
    new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
    {
      auth: { username: CLIENT_ID, password: CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  return res.data.access_token;
}

// ──────────────────────────────────────────────────────────────
//  APS OSS
// ──────────────────────────────────────────────────────────────
async function ensureBucket(token) {
  try {
    await axios.post(
      `${APS_BASE}/oss/v2/buckets`,
      { bucketKey: BUCKET_KEY, policyKey: 'temporary' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    if (e.response?.status !== 409) throw e;
  }
}

async function uploadToOSS(token, filePath, fileName) {
  const fileData = fs.readFileSync(filePath);
  const objectKey = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const encodedKey = encodeURIComponent(objectKey);

  // Step 1: Get signed S3 upload URL
  let uploadKey, signedUrl;
  try {
    const signRes = await axios.get(
      `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${encodedKey}/signeds3upload`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    uploadKey = signRes.data.uploadKey;
    signedUrl = signRes.data.urls[0];
    console.log('[APS] Got signed upload URL');
  } catch (e) {
    throw new Error(`OSS signed URL failed (${e.response?.status}): ${JSON.stringify(e.response?.data) || e.message}`);
  }

  // Step 2: Upload file to S3
  let retries = 3;
  let lastError;
  while (retries > 0) {
    try {
      await axios.put(signedUrl, fileData, {
        headers: { 'Content-Type': 'application/octet-stream' },
        maxBodyLength: Infinity, maxContentLength: Infinity
      });
      console.log('[APS] File uploaded to S3');
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      retries--;
      console.log(`[APS] S3 upload failed, retrying... (${retries} left)`);
      if (e.message.includes('EAI_AGAIN') || e.message.includes('ENOTFOUND')) {
        // Fallback for DNS issues with s3-accelerate
        console.log('[APS] Network DNS error detected. Falling back to standard S3 URL...');
        signedUrl = signedUrl.replace('s3-accelerate.amazonaws.com', 's3.amazonaws.com');
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  if (lastError) {
     throw new Error(`S3 upload failed (${lastError.response?.status}): ${lastError.message}`);
  }

  // Step 3: Finalize
  try {
    await axios.post(
      `${APS_BASE}/oss/v2/buckets/${BUCKET_KEY}/objects/${encodedKey}/signeds3upload`,
      { uploadKey },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('[APS] Upload finalized');
  } catch (e) {
    throw new Error(`OSS finalize failed (${e.response?.status}): ${JSON.stringify(e.response?.data) || e.message}`);
  }

  return `urn:adsk.objects:os.object:${BUCKET_KEY}/${objectKey}`;
}

// ──────────────────────────────────────────────────────────────
//  MODEL DERIVATIVE
// ──────────────────────────────────────────────────────────────
async function requestTranslation(token, objectUrn) {
  const encodedUrn = Buffer.from(objectUrn).toString('base64');
  const safeUrn = encodedUrn.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    await axios.post(
      `${APS_BASE}/modelderivative/v2/designdata/job`,
      {
        input: { urn: safeUrn },
        output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] }
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'true' } }
    );
  } catch (e) {
    throw new Error(`Translation failed (${e.response?.status}): ${JSON.stringify(e.response?.data) || e.message}`);
  }
  return safeUrn;
}

async function getTranslationStatus(token, urn) {
  const res = await axios.get(
    `${APS_BASE}/modelderivative/v2/designdata/${urn}/manifest`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

async function getModelProperties(token, urn) {
  const treeRes = await axios.get(
    `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const guids = (treeRes.data.data?.metadata || []).map(m => m.guid);
  const allProps = [];
  for (const guid of guids) {
    try {
      const propRes = await axios.get(
        `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties?forceget=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const coll = propRes.data?.data?.collection;
      if (Array.isArray(coll)) allProps.push(...coll);
    } catch (_) {}
  }
  return allProps;
}

// ──────────────────────────────────────────────────────────────
//  DLTM ↔ WGS84 COORDINATE CONVERSION
//  Dubai Local Transverse Mercator (EPSG-like, based on WGS84)
// ──────────────────────────────────────────────────────────────
const DLTM = {
  a: 6378137.0,            // WGS84 semi-major axis
  f: 1 / 298.257223563,    // WGS84 flattening
  k0: 0.999901,            // Scale factor at central meridian
  lon0: 55.0 + 20.0/60.0,  // Central meridian 55°20'E = 55.3333...°
  lat0: 0,                 // Latitude of origin
  FE: 500000,              // False Easting
  FN: 0                    // False Northing
};
DLTM.e2 = 2 * DLTM.f - DLTM.f * DLTM.f;
DLTM.e = Math.sqrt(DLTM.e2);
DLTM.ep2 = DLTM.e2 / (1 - DLTM.e2);

function dltmToWgs84(easting, northing) {
  const { a, e2, ep2, k0, lon0, FE, FN } = DLTM;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const M = (northing - FN) / k0;
  const mu = M / (a * (1 - e2/4 - 3*e2*e2/64 - 5*e2*e2*e2/256));

  const phi1 = mu
    + (3*e1/2 - 27*e1*e1*e1/32) * Math.sin(2*mu)
    + (21*e1*e1/16 - 55*e1*e1*e1*e1/32) * Math.sin(4*mu)
    + (151*e1*e1*e1/96) * Math.sin(6*mu)
    + (1097*e1*e1*e1*e1/512) * Math.sin(8*mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const T1 = tanPhi1 * tanPhi1;
  const C1 = ep2 * cosPhi1 * cosPhi1;
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = (easting - FE) / (N1 * k0);

  const lat = phi1
    - (N1 * tanPhi1 / R1) * (
        D*D/2
        - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * D*D*D*D/24
        + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * D*D*D*D*D*D/720
      );

  const lon = (lon0 * Math.PI / 180) + (
      D
      - (1 + 2*T1 + C1) * D*D*D/6
      + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * D*D*D*D*D/120
    ) / cosPhi1;

  return {
    lat: lat * 180 / Math.PI,
    lng: lon * 180 / Math.PI
  };
}

// ──────────────────────────────────────────────────────────────
//  CAD PROPERTY EXTRACTION
// ──────────────────────────────────────────────────────────────
function extractParcelsFromProps(properties) {
  const parcels = [];
  const seen = new Set();

  for (const obj of properties) {
    if (!obj.name || !obj.name.includes('ParcelInformation')) continue;
    const attrs = obj.properties?.['Attributes'] || {};
    const plotNo = (attrs['ID'] || '').trim();
    if (!plotNo || seen.has(plotNo)) continue;
    seen.add(plotNo);

    const areaStr = (attrs['AREA'] || '').replace(/sqm/gi,'').replace(/,/g,'').trim();
    const gfaStr  = (attrs['GFA:'] || '').replace(/GFA:/gi,'').replace(/sqm/gi,'').replace(/,/g,'').trim();

    parcels.push({
      plot_no:     plotNo,
      plot_no2:    (attrs['ID2'] || '').trim() || null,
      area:        parseFloat(areaStr) || 0,
      gfa:         parseFloat(gfaStr) || 0,
      description: (attrs['DESCRIPTION'] || '').trim() || null,
      height:      (attrs['HEIGHT'] || '').trim() || null,
      handle:      obj.properties?.['General']?.['Handle'] || ''
    });
  }
  return parcels;
}

// ──────────────────────────────────────────────────────────────
//  DATA PERSISTENCE
// ──────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────
//  DATA PERSISTENCE & MIGRATION
// ──────────────────────────────────────────────────────────────
const CAD_RECORDS_FILE = path.join(__dirname, 'cad_records.json');
const EXCEL_FILE       = path.join(__dirname, 'excel_data.json');
const MERGED_FILE      = path.join(__dirname, 'data.json');

// Legacy files for migration
const LEGACY_CAD_SINGLE = path.join(__dirname, 'cad_record.json');
const LEGACY_CAD_ARRAY  = path.join(__dirname, 'cad_data.json');

function loadJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}

function saveJSON(fp, data) {
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function loadCadRecords() {
  let records = loadJSON(CAD_RECORDS_FILE);
  if (!Array.isArray(records)) records = [];

  let migrated = false;

  // Migration from single object format
  const single = loadJSON(LEGACY_CAD_SINGLE);
  if (single && single.urn && !records.find(r => r.urn === single.urn)) {
    records.push(single);
    console.log('[MIGRATION] Added legacy record from cad_record.json');
    migrated = true;
  }
  
  // Migration from legacy array format (cad_data.json)
  const legacyArray = loadJSON(LEGACY_CAD_ARRAY);
  if (Array.isArray(legacyArray) && legacyArray.length > 0) {
    const legacyUrn = 'legacy-cad-data';
    if (!records.find(r => r.urn === legacyUrn)) {
       records.push({
         urn: legacyUrn,
         filename: 'migrated_cad_data.dwg',
         extractedAt: new Date().toISOString(),
         parcels: legacyArray
       });
       console.log('[MIGRATION] Added legacy array from cad_data.json');
       migrated = true;
    }
  }

  if (migrated) saveJSON(CAD_RECORDS_FILE, records);
  return records;
}

function loadExcelData()  { return loadJSON(EXCEL_FILE) || []; }

function loadMergedData() {
  const data = loadJSON(MERGED_FILE);
  if (data && !Array.isArray(data)) return data; 
  
  // If it's an array, it's legacy merged data without URN keys
  if (Array.isArray(data)) {
    console.log('[MIGRATION] Merged data was an array, resetting to empty object for multi-model support.');
    return {};
  }
  return {};
}

// Merge CAD parcels with Excel data by plot_no matching
function mergeData(cadParcels, excelRows) {
  if (!cadParcels || !cadParcels.length) return excelRows || [];
  if (!excelRows || !excelRows.length) {
    // Return CAD data only with inferred land_use from description
    return cadParcels.map(p => ({
      plot_no:   p.plot_no,
      plot_no2:  p.plot_no2,
      zone:      inferZone(p.plot_no),
      land_use:  p.description || inferLandUse(p.plot_no),
      gfa:       p.gfa || 0,
      far:       0,
      height:    (p.height && p.height !== '-') ? p.height : null,
      units:     0,
      area:      p.area || 0,
      status:    'Active',
      source:    'CAD',
      handle:    p.handle
    }));
  }

  // Build lookup from Excel by plot_no
  const excelMap = {};
  excelRows.forEach(row => {
    const key = String(row.plot_no || '').trim();
    if (key) excelMap[key] = row;
  });

  // Merge: CAD is base, Excel enriches
  const merged = cadParcels.map(cad => {
    const ex = excelMap[cad.plot_no] || excelMap[cad.plot_no2] || {};
    return {
      ...ex,
      plot_no:   cad.plot_no,
      plot_no2:  cad.plot_no2,
      zone:      ex.zone || inferZone(cad.plot_no),
      land_use:  ex.land_use || cad.description || inferLandUse(cad.plot_no),
      gfa:       parseFloat(ex.gfa) || cad.gfa || 0,
      far:       parseFloat(ex.far) || 0,
      height:    ex.height || ((cad.height && cad.height !== '-') ? cad.height : null),
      units:     parseInt(ex.units) || 0,
      area:      parseFloat(ex.area) || cad.area || 0,
      status:    ex.status || 'Active',
      source:    ex.zone ? 'CAD+Excel' : 'CAD',
      handle:    cad.handle,
      // DLTM coordinates from Excel if provided
      easting:   parseFloat(ex.easting) || parseFloat(ex.x) || null,
      northing:  parseFloat(ex.northing) || parseFloat(ex.y) || null
    };
  });

  // Add any Excel rows NOT in CAD
  excelRows.forEach(ex => {
    const key = String(ex.plot_no || '').trim();
    if (key && !cadParcels.find(c => c.plot_no === key || c.plot_no2 === key)) {
      merged.push({
        ...ex,
        source: 'Excel',
        easting: parseFloat(ex.easting) || parseFloat(ex.x) || null,
        northing: parseFloat(ex.northing) || parseFloat(ex.y) || null
      });
    }
  });

  return merged;
}

function inferZone(plotNo) {
  if (!plotNo) return null;
  const match = plotNo.match(/^([A-Z]{2})[\.\-]/);
  return match ? match[1] : null;
}

function inferLandUse(plotNo) {
  if (!plotNo) return 'Unclassified';
  const l = plotNo.toLowerCase();
  if (/^row/i.test(l)) return 'Right of Way';
  // Match zone codes: XX.##.T = Town, XX.##.O = Open Space, etc.
  const typeMatch = plotNo.match(/\.\d+\.([A-Z])\./);
  if (typeMatch) {
    const t = typeMatch[1];
    if (t === 'T') return 'Townhouse';
    if (t === 'O') return 'Open Space';
    if (t === 'C') return 'Commercial';
    if (t === 'M') return 'Mixed Use';
    if (t === 'I') return 'Institutional';
    if (t === 'U') return 'Utility';
    if (t === 'R') return 'Residential';
  }
  return 'Unclassified';
}

// ──────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────

// APS viewer token
app.get('/api/token', async (req, res) => {
  if (!apsConfigured()) return res.status(503).json({ error: 'APS not configured' });
  try {
    const token = await getToken(['viewables:read']);
    res.json({ access_token: token, expires_in: 3599 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// APS + CAD status
app.get('/api/aps-status', (req, res) => {
  res.json({
    configured: apsConfigured(),
    records: loadCadRecords()
  });
});

app.delete('/api/model/:urn', (req, res) => {
  let records = loadCadRecords();
  const urn = req.params.urn;
  records = records.filter(r => r.urn !== urn);
  saveJSON(CAD_RECORDS_FILE, records);
  
  // Also clean up merged data
  const allMerged = loadMergedData();
  delete allMerged[urn];
  saveJSON(MERGED_FILE, allMerged);

  res.json({ success: true });
});

// Upload DWG → APS translate
app.post('/api/upload-dwg', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const ext = path.extname(req.file.originalname).toLowerCase();

  if (!apsConfigured()) {
    fs.unlinkSync(req.file.path);
    return res.status(503).json({ error: 'APS credentials not configured.' });
  }

  try {
    const token = await getToken();
    await ensureBucket(token);
    console.log('[APS] Bucket OK. Uploading:', req.file.originalname);
    const objectUrn = await uploadToOSS(token, req.file.path, req.file.originalname);
    console.log('[APS] Upload OK. URN:', objectUrn);
    const urn = await requestTranslation(token, objectUrn);
    console.log('[APS] Translation started. Encoded URN:', urn);
    fs.unlinkSync(req.file.path);
    res.json({ urn, message: 'DWG uploaded — translation started' });
  } catch (e) {
    console.error('[APS ERROR]', e.message);
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// Poll translation status
app.get('/api/status/:urn', async (req, res) => {
  if (!apsConfigured()) return res.status(503).json({ error: 'APS not configured' });
  try {
    const token = await getToken(['data:read']);
    const manifest = await getTranslationStatus(token, req.params.urn);
    res.json(manifest);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Extract properties after translation → save as CAD record
app.get('/api/properties/:urn', async (req, res) => {
  if (!apsConfigured()) return res.status(503).json({ error: 'APS not configured' });
  try {
    const token = await getToken(['data:read']);
    const props = await getModelProperties(token, req.params.urn);
    const parcels = extractParcelsFromProps(props);

    // Get view GUIDs
    const mdRes = await axios.get(
      `${APS_BASE}/modelderivative/v2/designdata/${req.params.urn}/metadata`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const views = {};
    (mdRes.data.data?.metadata || []).forEach(v => { views[v.role + '_' + v.name] = v.guid; });

    // Save persistent CAD record to array
    const cadRecord = {
      id: Date.now().toString(),
      urn: req.params.urn,
      filename: req.query.filename || 'unknown.dwg',
      extractedAt: new Date().toISOString(),
      viewGuids: views,
      parcels
    };
    const records = loadCadRecords();
    const existing = records.findIndex(r => r.urn === req.params.urn);
    if (existing >= 0) records[existing] = cadRecord;
    else records.push(cadRecord);
    
    saveJSON(CAD_RECORDS_FILE, records);
    console.log(`[CAD] Saved ${parcels.length} parcels from file`);

    // Merge with any existing Excel data
    const excelData = loadExcelData();
    const merged = mergeData(parcels, excelData);
    
    // Save to merged cache (keyed by urn)
    const allMerged = loadMergedData();
    allMerged[req.params.urn] = merged;
    saveJSON(MERGED_FILE, allMerged);

    res.json(merged);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update plot properties manually from UI
app.post('/api/plots/update', (req, res) => {
  const { urn, plot_no, updates } = req.body;
  if (!plot_no || !updates) return res.status(400).json({ error: 'Missing plot_no or updates' });

  // 1. Update in merged cache
  const allMerged = loadMergedData();
  const updateArr = (arr) => {
    const idx = arr.findIndex(p => p.plot_no === plot_no);
    if (idx !== -1) arr[idx] = { ...arr[idx], ...updates };
  };

  if (urn && allMerged[urn]) {
    updateArr(allMerged[urn]);
  } else {
    // Fallback search across all models if URN not provided
    Object.values(allMerged).forEach(updateArr);
  }
  saveJSON(MERGED_FILE, allMerged);

  // 2. Update in CAD records (if matched)
  const records = loadCadRecords();
  records.forEach(r => {
    const p = r.parcels.find(x => x.plot_no === plot_no);
    if (p) Object.assign(p, updates);
  });
  saveJSON(CAD_RECORDS_FILE, records);

  res.json({ success: true });
});

// Update coordinates for parcels (from Magic Map Sync)
app.post('/api/plots/update-coords', (req, res) => {
  const { urn, updates } = req.body;
  if (!urn || !updates || !Array.isArray(updates)) return res.status(400).json({ error: 'Missing urn or updates' });

  // 1. Update central records
  const records = loadCadRecords();
  const recIdx = records.findIndex(r => r.urn === urn);
  if (recIdx !== -1) {
    updates.forEach(upd => {
      const p = records[recIdx].parcels.find(x => x.handle === upd.handle || (x.plot_no === upd.plot_no && upd.plot_no));
      if (p) {
        p.easting = upd.easting;
        p.northing = upd.northing;
        console.log(`[COORD] Updated ${p.plot_no} (${p.handle})`);
      }
    });
    saveJSON(CAD_RECORDS_FILE, records);
  }

  // 2. Update merged cache
  const allMerged = loadMergedData();
  if (allMerged[urn]) {
    updates.forEach(upd => {
      const p = allMerged[urn].find(x => x.handle === upd.handle || (x.plot_no === upd.plot_no && upd.plot_no));
      if (p) {
        p.easting = upd.easting;
        p.northing = upd.northing;
      }
    });
    saveJSON(MERGED_FILE, allMerged);
  }

  res.json({ success: true, count: updates.length });
});

// Upload Excel → merge with CAD data
app.post('/api/upload-excel', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const wb    = xlsx.readFile(req.file.path);
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // Get as 2D array to find header row dynamically
    const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    let headerRowIdx = 0;
    
    for (let i = 0; i < Math.min(20, rawData.length); i++) {
       const rowStr = (rawData[i] || []).join(' ').toLowerCase();
       if (rowStr.includes('plot no') || rowStr.includes('zone') || rowStr.includes('gfa')) {
          headerRowIdx = i;
          break;
       }
    }
    
    const headers = rawData[headerRowIdx] || [];
    const mappedRows = [];
    
    for (let i = headerRowIdx + 1; i < rawData.length; i++) {
        const rowArr = rawData[i];
        if (!rowArr || rowArr.length === 0) continue;
        
        const row = {};
        headers.forEach((h, idx) => {
            if (h) row[h] = rowArr[idx];
        });
        mappedRows.push(row);
    }

    console.log('[Excel] Found headers at row', headerRowIdx, ':', headers);

    // Flexible column mapping
    const excelRows = mappedRows.map(row => {
      const mapped = {
        ...row,
        plot_no:  String(row['Plot No.'] || row['PLOT NO'] || row['Plot No'] || row['plot_no'] || row['ID'] || row['Id'] || row['id'] || '').trim() || null,
        zone:     String(row['ZONE'] || row['Zone'] || row['zone'] || row['Zone Code'] || '').trim() || null,
        land_use: String(row['LAND USE'] || row['Land Use'] || row['land_use'] || row['Land use'] || row['Description'] || row['DESCRIPTION'] || '').trim() || null,
        gfa:      parseFloat(row['TOTAL GFA'] || row['GFA'] || row['gfa'] || row['Total GFA'] || row['Gross Floor Area'] || 0) || 0,
        far:      parseFloat(row['FAR'] || row['far'] || row['Floor Area Ratio'] || 0) || 0,
        height:   String(row['PROPOSED HEIGHT'] || row['Height'] || row['height'] || row['Proposed Height'] || row['MAX HEIGHT'] || '').trim() || null,
        units:    parseInt(row['Nr. of Residential Units'] || row['Units'] || row['units'] || row['UNITS'] || row['Residential Units'] || 0) || 0,
        area:     parseFloat(row['PLOT AREA'] || row['Plot Area'] || row['Area'] || row['area'] || row['AREA'] || 0) || 0,
        status:   String(row['Comment'] || row['Status'] || row['status'] || 'Active').trim(),
        // DLTM coordinates
        easting:  parseFloat(row['Easting'] || row['EASTING'] || row['X'] || row['x'] || row['E'] || 0) || null,
        northing: parseFloat(row['Northing'] || row['NORTHING'] || row['Y'] || row['y'] || row['N'] || 0) || null
      };
      return mapped;
    }).filter(p => p.plot_no);

    // Save Excel data
    saveJSON(EXCEL_FILE, excelRows);
    
    // Create a record for this Excel upload
    const records = loadCadRecords();
    const excelUrn = 'excel-' + Date.now();
    records.push({
       urn: excelUrn,
       filename: req.file.originalname,
       type: 'Excel',
       extractedAt: new Date().toISOString(),
       parcels: excelRows
    });
    saveJSON(CAD_RECORDS_FILE, records);

    // Merge with ALL model records
    const allMerged = loadMergedData();
    records.forEach(rec => {
       if (rec.type === 'Excel') {
          allMerged[rec.urn] = rec.parcels; // Excel only
       } else {
          allMerged[rec.urn] = mergeData(rec.parcels, excelRows);
       }
    });
    saveJSON(MERGED_FILE, allMerged);

    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.json({
      message: `Excel processed and saved as record. Merged with ${records.filter(r => r.type !== 'Excel').length} models.`,
      urn: excelUrn
    });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// Get stored merged data for a specific URN
app.get('/api/plots/:urn?', (req, res) => {
  const allMerged = loadMergedData();
  let plots = [];
  
  const urn = req.params.urn;
  if (urn) {
    plots = allMerged[urn] || [];
    
    // Fallback: if cache is empty, rebuild from records + current excel
    if (plots.length === 0) {
      const records = loadCadRecords();
      const rec = records.find(r => r.urn === urn);
      if (rec) {
        if (rec.type === 'Excel') {
          plots = rec.parcels;
        } else {
          plots = mergeData(rec.parcels, loadExcelData());
        }
        // Update cache
        allMerged[urn] = plots;
        saveJSON(MERGED_FILE, allMerged);
      }
    }
  } else {
    // Return the most recent one if no URN specified
    const urns = Object.keys(allMerged);
    if (urns.length > 0) {
      plots = allMerged[urns[urns.length - 1]];
    } else {
       // Deep fallback for boot: check records
       const records = loadCadRecords();
       if (records.length > 0) {
          plots = mergeData(records[records.length-1].parcels, loadExcelData());
       }
    }
  }

  const withCoords = plots.map(p => {
    if (p.easting && p.northing) {
      const { lat, lng } = dltmToWgs84(p.easting, p.northing);
      return { ...p, lat, lng };
    }
    return p;
  });
  res.json(withCoords);
});

// Get most recent CAD record info (for legacy support)
app.get('/api/cad-record', (req, res) => {
  const records = loadCadRecords();
  if (!records.length) return res.json({ exists: false });
  const rec = records[records.length - 1];
  res.json({
    exists: true,
    filename: rec.filename,
    urn: rec.urn,
    parcelCount: rec.parcels?.length || 0,
    extractedAt: rec.extractedAt,
    viewGuids: rec.viewGuids
  });
});

// Clear plots
app.delete('/api/plots', (req, res) => {
  saveJSON(MERGED_FILE, []);
  res.json({ message: 'Cleared' });
});

// Clear everything
app.delete('/api/all', (req, res) => {
  saveJSON(MERGED_FILE, {});
  try { fs.unlinkSync(EXCEL_FILE); } catch (_) {}
  try { fs.unlinkSync(CAD_RECORDS_FILE); } catch (_) {}
  try { fs.unlinkSync(LEGACY_CAD_SINGLE); } catch (_) {}
  try { fs.unlinkSync(LEGACY_CAD_ARRAY); } catch (_) {}
  res.json({ message: 'All data cleared' });
});

// Serve frontend
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../frontend/public/index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.send('<h2>Frontend not built</h2>');
});

// ──────────────────────────────────────────────────────────────
//  BOOT
// ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 MasterPlan Dashboard running at http://localhost:${PORT}\n`);
  const records = loadCadRecords();
  if (records.length > 0) {
    console.log(`[BOOT] Loaded ${records.length} model records.`);
    records.forEach(r => console.log(` - ${r.filename}: ${r.parcels?.length} parcels (URN: ${r.urn})`));
  }
});
