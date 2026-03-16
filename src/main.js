import { Client, Databases, Query } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  // 1. Parse Payload
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    payload = req.body;
  }

  // 2. Extract Data from tx_ref or manual props
  // tx_ref format: "TERM_AS_UBC_1742116..." or "FULL_AS_UBC_..."
  const txRef = payload.tx_ref || ""; 
  const isTerm = txRef.startsWith('TERM_');
  const isFull = txRef.startsWith('FULL_');

  // If manual trigger via LicenseService.activateLicenseExecution(schoolCode, planLabel)
  const schoolCode = payload.schoolCode || (txRef.split('_')[2]); 
  const plan = payload.plan || (isTerm ? 'Termly' : isFull ? 'Sessional' : 'Manual');

  if (!schoolCode) {
    error('Metadata Error: schoolCode could not be determined.');
    return res.json({ success: false, message: 'Missing schoolCode' }, 400);
  }

  log(`Processing: School [${schoolCode}] | Plan [${plan}] | Ref [${txRef}]`);

  // 3. Initialize SDK
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  try {
    // 4. Locate School Record
    const response = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.COLLECTION_ID,
      [Query.equal('schoolCode', schoolCode)]
    );

    if (response.total === 0) {
      return res.json({ success: false, message: 'School not found in cloud' }, 404);
    }

    const document = response.documents[0];
    const currentExpiry = new Date(document.expiryDate);
    const baseDate = (currentExpiry > new Date()) ? currentExpiry : new Date();
    let newExpiry = new Date(baseDate);

    // 5. Apply Extension Logic based on tx_ref or Plan Label
    if (isFull || plan === 'Sessional') {
      newExpiry.setFullYear(newExpiry.getFullYear() + 1);
      log(`Action: Adding 1 Year (Sessional)`);
    } else if (isTerm || plan === 'Termly') {
      newExpiry.setMonth(newExpiry.getMonth() + 4);
      log(`Action: Adding 4 Months (Termly)`);
    } else {
      // Emergency default: 1 month
      newExpiry.setMonth(newExpiry.getMonth() + 1);
      log(`Action: Default 1 Month applied`);
    }

    // 6. Update Cloud
    await databases.updateDocument(
      process.env.DATABASE_ID,
      process.env.COLLECTION_ID,
      document.$id,
      {
        expiryDate: newExpiry.toISOString(),
        isActive: true
      }
    );

    log(`SUCCESS: ${schoolCode} updated to ${newExpiry.toISOString()}`);
    
    return res.json({ 
      success: true, 
      newExpiry: newExpiry.toISOString() 
    }, 200);

  } catch (err) {
    error(`Processing Error: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
