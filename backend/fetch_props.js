require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const APS_BASE = 'https://developer.api.autodesk.com';
const CLIENT_ID = process.env.APS_CLIENT_ID;
const CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

async function run() {
  try {
    const res = await axios.post(
      `${APS_BASE}/authentication/v2/token`,
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read data:read data:write' }),
      {
        auth: { username: CLIENT_ID, password: CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    const token = res.data.access_token;
    
    // The URN from cad_records.json
    const urn = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6bWFzdGVycGxhbi1kd2ctYnVja2V0L0MzMDgyLURXRy03U0kwNTMwLU1QLTAwMDAwMDFfMl8uZHdn';

    const treeRes = await axios.get(
      `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    const guids = (treeRes.data.data?.metadata || []).map(m => m.guid);
    const allProps = [];
    
    for (const guid of guids) {
       const propRes = await axios.get(
         `${APS_BASE}/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties?forceget=true`,
         { headers: { Authorization: `Bearer ${token}` } }
       );
       const coll = propRes.data?.data?.collection;
       if (Array.isArray(coll)) allProps.push(...coll);
    }
    
    fs.writeFileSync('raw_props.json', JSON.stringify(allProps, null, 2));
    console.log('Saved raw_props.json. Length:', allProps.length);
  } catch (err) {
    console.error(err.message, err.response?.data);
  }
}

run();
