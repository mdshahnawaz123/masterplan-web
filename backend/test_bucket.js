const axios = require('axios');
const APS_BASE = 'https://developer.api.autodesk.com';
const BUCKET_KEY = 'mplan-mnzplqu3';
const CLIENT_ID = 'kBpgvULrk2enDO3RXJUEQGcqAkXzCxmlXZ5m2CuGw1NLUbTw';
const CLIENT_SECRET = 'pr6IGBrgsDGtYdiuX4I8dSXNlLmBIk2rkjk3Ok8jld2OzutTeQSlRuPe0YNCiQ3i';

async function test() {
  try {
    const res = await axios.post(
      `${APS_BASE}/authentication/v2/token`,
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'bucket:create bucket:read data:read data:write data:create' }),
      {
        auth: { username: CLIENT_ID, password: CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    const token = res.data.access_token;
    console.log('Token acquired');

    await axios.post(
      `${APS_BASE}/oss/v2/buckets`,
      { bucketKey: BUCKET_KEY, policyKey: 'temporary' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('Bucket created!');
  } catch (e) {
    if (e.response?.status !== 409) {
       console.error('Error:', e.response?.status, e.response?.data);
    } else {
       console.log('Bucket exists (409)');
    }
  }
}
test();
