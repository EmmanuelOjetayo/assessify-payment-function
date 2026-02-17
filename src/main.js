import { Client, Databases, Query } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  // 1. Parse the Payload (Handles string, object, or Webhook JSON)
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    payload = req.body;
  }

  // 2. Identify Trigger Source & Security
  const flwHeader = req.headers['verif-hash'];
  const secretHash = process.env.FLW_SECRET_HASH;
  const isManual = !flwHeader;

  if (!isManual) {
    // Webhook Security Check
    if (flwHeader !== secretHash) {
      error('Unauthorized: Signature mismatch from Flutterwave');
      return res.json({ success: false, message: 'Unauthorized' }, 401);
    }
  } else {
    log('Processing Manual Trigger from Assessify React App...');
  }

  // 3. Extract Key Data
  // Handles React payload { schoolCode, plan } or FLW payload { meta: { schoolCode }, amount }
  const schoolCode = payload.schoolCode || payload.meta?.schoolCode;
  let amountPaid = payload.amount || payload.meta?.amount;

  // If amount is missing (Manual trigger), infer it from the plan name
  if (!amountPaid && payload.plan) {
    amountPaid = payload.plan === 'Sessional' ? 50000 : 20000;
  }

  if (!schoolCode) {
    error('Metadata Error: schoolCode is missing from payload.');
    return res.json({ success: false, message: 'Missing schoolCode' }, 400);
  }

  log(`Payload Verified: School: ${schoolCode}, Amount detected: ₦${amountPaid}`);

  // 4. Initialize SDK
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  try {
    // 5. Locate School Record in Cloud
    const response = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.COLLECTION_ID,
      [Query.equal('schoolCode', schoolCode)]
    );

    if (response.total === 0) {
      error(`Database Error: No record found for school: ${schoolCode}`);
      return res.json({ success: false, message: 'School record not found' }, 404);
    }

    const document = response.documents[0];
    const currentExpiry = new Date(document.expiryDate);
    
    // Safety: Start from "Now" or "Current Expiry" (whichever is further)
    // This ensures users don't lose days if they renew early.
    const baseDate = (currentExpiry > new Date()) ? currentExpiry : new Date();
    let newExpiry = new Date(baseDate);

    // 6. Calculate Extension Logic (Explicit else if)
    if (amountPaid >= 50000) {
      // Sessional Plan: Add 1 Year
      newExpiry.setFullYear(newExpiry.getFullYear() + 1);
      log(`Plan: SESSIONAL detected. Extending 1 year for ${schoolCode}`);
    } 
    else if (amountPaid >= 20000) {
      // Termly Plan: Add 4 Months
      newExpiry.setMonth(newExpiry.getMonth() + 4);
      log(`Plan: TERMLY detected. Extending 4 months for ${schoolCode}`);
    } 
    else {
      // Fallback: If amount is somehow lower, give 1 month
      newExpiry.setMonth(newExpiry.getMonth() + 1);
      log(`Plan: MINIMUM/PROMO detected. Extending 1 month for ${schoolCode}`);
    }

    // 7. Update the Cloud Database
    await databases.updateDocument(
      process.env.DATABASE_ID,
      process.env.COLLECTION_ID,
      document.$id,
      {
        expiryDate: newExpiry.toISOString(),
        isActive: true
      }
    );

    log(`SUCCESS: ${schoolCode} license extended to ${newExpiry.toISOString()}`);
    
    return res.json({ 
      success: true, 
      school: schoolCode,
      newExpiry: newExpiry.toISOString(),
      message: 'License successfully updated'
    }, 200);

  } catch (err) {
    error(`System Error during processing: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
