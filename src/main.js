import { Client, Databases, Query } from 'node-appwrite';

/**
 * Assessify License Processor
 * Triggered by Flutterwave Webhook
 */
export default async ({ req, res, log, error }) => {
  // 1. Security Verification
  const flwHeader = req.headers['verif-hash'];
  const secretHash = process.env.FLW_SECRET_HASH;

  if (!flwHeader || flwHeader !== secretHash) {
    error('Unauthorized: Signature mismatch or missing hash');
    return res.json({ success: false, message: 'Unauthorized' }, 401);
  }

  // 2. Extract Data from Flutterwave Body
  const payload = req.body;

  // We only act on 'successful' status
  if (payload.status !== 'successful') {
    log(`Transaction ignored with status: ${payload.status}`);
    return res.json({ message: 'Transaction not successful, no action taken.' }, 200);
  }

  // 3. Initialize Appwrite SDK
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  // Retrieve Metadata from payment
  const schoolCode = payload.meta?.schoolCode;
  const amountPaid = payload.amount;

  if (!schoolCode) {
    error('Metadata Error: schoolCode is missing from the transaction meta.');
    return res.json({ success: false, message: 'Missing schoolCode' }, 400);
  }

  try {
    // 4. Locate the School Record
    const response = await databases.listDocuments(
      process.env.DATABASE_ID,
      process.env.COLLECTION_ID,
      [Query.equal('schoolCode', schoolCode)]
    );

    if (response.total === 0) {
      error(`Database Error: No license record found for school: ${schoolCode}`);
      return res.json({ success: false, message: 'School not found' }, 404);
    }

    const document = response.documents[0];
    const currentExpiry = new Date(document.expiryDate);
    
    // Logic: Start from "Now" or "Existing Expiry" (whichever is further)
    // This prevents schools from losing days if they renew early.
    const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
    let newExpiry = new Date(baseDate);

    // 5. Calculate Duration based on Plan
    // (Note: Flutterwave amounts are checked against your 20k/50k logic)
    if (amountPaid >= 50000) {
      newExpiry.setFullYear(newExpiry.getFullYear() + 1); // +1 Year
      log(`Processing SESSIONAL plan for ${schoolCode}`);
    } else if (amountPaid >= 20000) {
      newExpiry.setMonth(newExpiry.getMonth() + 4); // +4 Months (One Term)
      log(`Processing TERMLY plan for ${schoolCode}`);
    } else {
      // Default safety: if amount is lower, give 1 month
      newExpiry.setMonth(newExpiry.getMonth() + 1);
      log(`Processing DEFAULT (1 month) plan for ${schoolCode}`);
    }

    // 6. Update the Cloud Database
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
      expiry: newExpiry.toISOString() 
    }, 200);

  } catch (err) {
    error(`System Error: ${err.message}`);
    return res.json({ success: false, error: 'Internal Server Error' }, 500);
  }
};
