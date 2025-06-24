const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs/promises');
const Tesseract = require('tesseract.js');
const database = require('./utils/connection');
const { port, jwtSecret } = require('./config/ApplicationSettings');
const medicalKeywords = require('./heuristic_data');
const { authintication,authfilereq} = require('./utils/common'); // Import the utility function
const { log } = require('console');

const app = express();

app.use('/uploads', authfilereq, express.static(path.join(__dirname, 'uploads')));
app.use('/profiles', authfilereq, express.static(path.join(__dirname, 'profiles')));


// Multer setup
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    files: 10, // Maximum number of files the user can upload (e.g., 5 files)
    fileSize: 1024 * 1024, // Maximum file size (e.g., 10 MB per file)
  },
  fileFilter: (req, file, cb) => {
    // const allowedTypes = /png/; // Allow only .jpg files
    const allowedTypes = /jpeg|jpg|png|webp/; // Allow only .jpg files
    const fileExt = file.originalname.split('.').pop().toLowerCase();
    const isValidType = allowedTypes.test(fileExt);
    if (isValidType) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only jpeg,jpg,png,webp files are allowed.'));
    }
  },
});

const processImages = async (files, userId) => {
  const processedImages = [];
  for (const file of files) {
    const imageBuffer = file.buffer; // Extract the buffer from the uploaded file

    const currentDate = new Date().toISOString().replace(/[-:]/g, '');
    const original = sharp(imageBuffer); // Keep the original image for color and thumbnail

    // Create grayscale image for classification
    const grayscaleBuffer = await original
      .grayscale() // Apply grayscale to the original image buffer
      .toFormat('png')
      .toBuffer();

    // Create color image (no grayscale applied)
    const colorBuffer = await sharp(imageBuffer)  // Ensure color image is from the original, unmodified buffer
      .toFormat('png')
      .toBuffer();

    // Create thumbnail image from original color image buffer
    const thumbnailBuffer = await sharp(imageBuffer)
      .resize(200, 200, { fit: 'inside' }) // Adjust thumbnail size as needed
      .toFormat('png')
      .toBuffer();

    const grayscaleFilename = `${file.originalname}-gray-${userId}-${currentDate}.png`;
    const colorFilename = `${file.originalname}-color-${userId}-${currentDate}.png`;
    const thumbnailFilename = `${file.originalname}-thumbnail-${userId}-${currentDate}.png`;

    processedImages.push({
      grayscale: { buffer: grayscaleBuffer, filename: grayscaleFilename },
      color: { buffer: colorBuffer, filename: colorFilename },
      thumbnail: { buffer: thumbnailBuffer, filename: thumbnailFilename }, // Assign the thumbnail buffer
    });
  }
  return processedImages;
};


// Classification logic
const classifyImage = async (grayscaleImage) => {
  try {
    const { data: { text } } = await Tesseract.recognize(grayscaleImage, 'eng');
    const cleanedText = text.toLowerCase().replace(/\s+/g, ' ').trim();

    console.log("Extracted Text:", cleanedText);
    
    // const medicalKeywords = [ /* Your medical keywords */ ];

    const isMedicalDocument = medicalKeywords.some((keyword) =>
      cleanedText.includes(keyword)
    );
    return { isMedicalDocument, extractedText: text };
  } catch (error) {
    console.error('Error during classification:', error);
    return { isMedicalDocument: false, extractedText: '' };
  }
};



app.post('/uploadPrescription', upload.array('image'), async (req, res) => {
  const connection = await database.getConnection();
  try {
    const {
      accessToken,
      member_id,
      department,
      doctor_name,
      visited_date
    } = req.body;

    // Validate required member_id
    if (!member_id || !Number.isInteger(+member_id) || +member_id <= 0) {
      return res.status(400).json({ error: 'Invalid or missing member_id' });
    }

    // Optional validations
    if (department !== undefined && typeof department !== 'string') {
      return res.status(400).json({ error: 'department must be a string' });
    }

    if (doctor_name !== undefined && typeof doctor_name !== 'string') {
      return res.status(400).json({ error: 'doctor_name must be a string' });
    }

    if (visited_date !== undefined) {
      const visitDateParsed = new Date(visited_date);
      if (isNaN(visitDateParsed.getTime())) {
        return res.status(400).json({ error: 'Invalid visited_date format. Use YYYY-MM-DD' });
      }
    }

    // Authenticate
    const { decodedToken } = await authintication(accessToken, member_id, connection);

    // Check file presence
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    await connection.beginTransaction();

    // Build dynamic INSERT for prescriptions
    const fields = ['user_id'];
    const values = [member_id];
    const placeholders = ['$1'];
    let idx = 2;

    if (department) {
      fields.push('department');
      values.push(department);
      placeholders.push(`$${idx++}`);
    }

    if (doctor_name) {
      fields.push('doctor_name');
      values.push(doctor_name);
      placeholders.push(`$${idx++}`);
    }

    if (visited_date) {
      fields.push('visited_date');
      values.push(visited_date);
      placeholders.push(`$${idx++}`);
    }

    // Add CURRENT_DATE directly into SQL (not values[])
    fields.push('created_at');
    placeholders.push('CURRENT_DATE');

    const insertPrescriptionQuery = `
      INSERT INTO prescriptions (${fields.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING id
    `;

    const { id: prescriptionId } = await connection.queryOne(insertPrescriptionQuery, values);

    const uploadFolder = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadFolder, { recursive: true });

    const processedImages = await processImages(req.files, decodedToken.userId);
    const invalidImages = [];

    for (let i = 0; i < processedImages.length; i++) {
      const { grayscale, color, thumbnail } = processedImages[i];
      const classificationResult = await classifyImage(grayscale.buffer);

      if (!classificationResult.isMedicalDocument) {
        invalidImages.push({ index: i, filename: grayscale.filename });
        continue;
      }

      const colorPath = path.join(uploadFolder, color.filename);
      const thumbPath = path.join(uploadFolder, thumbnail.filename);
      await fs.writeFile(colorPath, color.buffer);
      await fs.writeFile(thumbPath, thumbnail.buffer);

      await connection.query(
        `INSERT INTO prescription_images (prescription_id, resiged, thumb, created_at)
         VALUES ($1, $2, $3, CURRENT_DATE)`,
        [prescriptionId, `/uploads/${color.filename}`, `/uploads/${thumbnail.filename}`]
      );
    }

    if (invalidImages.length > 0) {
      await connection.rollback();
      return res.status(400).json({
        error: 'Some files are not medical documents.',
        invalidImages
      });
    }

    await connection.commit();
    res.status(200).json({
      message: 'Prescription uploaded successfully.',
      prescriptionId
    });
  } catch (error) {
    await connection.rollback();

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'You can only upload a maximum of 10 files.' });
      } else if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds the limit.' });
      }
    }

    if (['Access token is required.', 'Invalid or expired access token.', 'Invalid user.'].includes(error.message)) {
      return res.status(403).json({ error: error.message });
    }

    console.error("Error uploading prescription:", error);
    return res.status(500).json({ error: 'An unknown error occurred.' });
  } finally {
    await connection.release();
  }
});


app.post('/appendPrescriptionImages', upload.array('image'), async (req, res) => {
  const connection = await database.getConnection();
  try {
    const { accessToken, member_id, prescription_id } = req.body;

    if (!member_id || !Number.isInteger(+member_id) || +member_id <= 0) {
      return res.status(400).json({ error: 'Invalid member_id' });
    }

    if (!prescription_id || !Number.isInteger(+prescription_id) || +prescription_id <= 0) {
      return res.status(400).json({ error: 'Invalid prescription_id' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded.' });
    }

    const { decodedToken } = await authintication(accessToken, member_id, connection);

 

    const prescription = await connection.queryOne(
      'SELECT user_id FROM prescriptions WHERE id = $1 AND deleted = false',
      [prescription_id]
    );
    if (!prescription || prescription.user_id !== +member_id) {
      return res.status(403).json({ error: 'Prescription not found or does not belong to this member.' });
    }

    await connection.beginTransaction();

    const uploadFolder = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadFolder, { recursive: true });

    const processedImages = await processImages(req.files, decodedToken.userId);
    const invalidImages = [];

    for (let i = 0; i < processedImages.length; i++) {
      const { grayscale, color, thumbnail } = processedImages[i];
      const classificationResult = await classifyImage(grayscale.buffer);

      if (!classificationResult.isMedicalDocument) {
        invalidImages.push({ index: i, filename: grayscale.filename });
        continue;
      }

      const colorPath = path.join(uploadFolder, color.filename);
      const thumbPath = path.join(uploadFolder, thumbnail.filename);
      await fs.writeFile(colorPath, color.buffer);
      await fs.writeFile(thumbPath, thumbnail.buffer);

      await connection.query(
        `INSERT INTO prescription_images (prescription_id, resiged, thumb, created_at)
         VALUES ($1, $2, $3, CURRENT_DATE)`,
        [prescription_id, `/uploads/${color.filename}`, `/uploads/${thumbnail.filename}`]
      );
    }

    if (invalidImages.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Some images are invalid.', invalidImages });
    }

    await connection.commit();
    res.status(200).json({ message: 'Images appended successfully to prescription.' });
  } catch (error) {
    await connection.rollback();
    console.error("Error appending prescription images:", error);
    res.status(500).json({ error: 'An unknown error occurred.' });
  } finally {
    await connection.release();
  }
});


























app.post('/uploadReports', upload.array('image'), async (req, res) => {
  const connection = await database.getConnection();
  try {
    const {
      accessToken,
      member_id,
      prescription_id,
      shared,
      test_name,
      deliveryDate
    } = req.body;

    // Validate required member_id
    if (!member_id || !Number.isInteger(+member_id) || +member_id <= 0) {
      return res.status(400).json({ error: 'Invalid or missing member_id' });
    }

    // Optional validations
    if (prescription_id !== undefined && (!Number.isInteger(+prescription_id) || +prescription_id <= 0)) {
      return res.status(400).json({ error: 'Invalid prescription_id' });
    }

    if (prescription_id !== undefined) {
      const prescription = await connection.queryOne(
        `SELECT user_id FROM prescriptions WHERE id = $1 AND deleted = false`,
        [prescription_id]
      );

      if (!prescription) {
        return res.status(404).json({ error: 'Prescription not found.' });
      }

      if (prescription.user_id !== +member_id) {
        return res.status(403).json({ error: 'Unauthorized. Prescription does not belong to this member.' });
      }
    }

    

    if (shared !== undefined && shared !== 'true' && shared !== 'false' && shared !== true && shared !== false) {
      return res.status(400).json({ error: 'Invalid shared value. Must be true or false' });
    }

    if (test_name !== undefined && typeof test_name !== 'string') {
      return res.status(400).json({ error: 'test_name must be a string' });
    }

    if (deliveryDate !== undefined) {
      const date = new Date(deliveryDate);
      if (isNaN(date.getTime())) {
        return res.status(400).json({ error: 'Invalid deliveryDate format. Use YYYY-MM-DD' });
      }
    }

    const { decodedToken } = await authintication(accessToken, member_id, connection);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    await connection.beginTransaction();

    const fields = ['user_id'];
    const values = [member_id];
    const placeholders = ['$1'];
    let idx = 2;

    if (prescription_id !== undefined) {
      fields.push('prescription_id');
      values.push(prescription_id);
      placeholders.push(`$${idx++}`);
    }

    if (shared !== undefined) {
      fields.push('shared');
      values.push(shared === 'true' || shared === true); // Convert to boolean
      placeholders.push(`$${idx++}`);
    }

    if (test_name) {
      fields.push('test_name');
      values.push(test_name);
      placeholders.push(`$${idx++}`);
    }

    if (deliveryDate) {
      fields.push('delivery_date');
      values.push(deliveryDate); // Expecting string 'YYYY-MM-DD'
      placeholders.push(`$${idx++}`);
    }

    // Append created_at directly as SQL keyword
    fields.push('created_at');
    placeholders.push('CURRENT_DATE'); // Don't add to values

    const insertQuery = `INSERT INTO reports (${fields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`;
    const { id: reportId } = await connection.queryOne(insertQuery, values);

    const uploadFolder = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadFolder, { recursive: true });

    const processedImages = await processImages(req.files, decodedToken.userId);
    const invalidImages = [];

    for (let i = 0; i < processedImages.length; i++) {
      const { grayscale, color, thumbnail } = processedImages[i];
      const classificationResult = await classifyImage(grayscale.buffer);

      if (!classificationResult.isMedicalDocument) {
        invalidImages.push({ index: i, filename: grayscale.filename });
        continue;
      }

      const colorPath = path.join(uploadFolder, color.filename);
      const thumbPath = path.join(uploadFolder, thumbnail.filename);
      await fs.writeFile(colorPath, color.buffer);
      await fs.writeFile(thumbPath, thumbnail.buffer);

      await connection.query(
        `INSERT INTO report_images (report_id, resiged, thumb, created_at)
         VALUES ($1, $2, $3, CURRENT_DATE)`,
        [reportId, `/uploads/${color.filename}`, `/uploads/${thumbnail.filename}`]
      );
    }

    if (invalidImages.length > 0) {
      await connection.rollback();
      return res.status(400).json({
        error: 'Some files are not medical documents.',
        invalidImages
      });
    }

    await connection.commit();
    res.status(200).json({ message: 'Report uploaded successfully.', reportId });
  } catch (error) {
    await connection.rollback();

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'You can only upload a maximum of 10 files.' });
      } else if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds the limit.' });
      }
    }

    if (['Access token is required.', 'Invalid or expired access token.', 'Invalid user.'].includes(error.message)) {
      return res.status(403).json({ error: error.message });
    }

    console.error("Error processing report upload:", error);
    return res.status(500).json({ error: 'An unknown error occurred.' });
  } finally {
    await connection.release();
  }
});


app.post('/appendReportImages', upload.array('image'), async (req, res) => {
  const connection = await database.getConnection();
  try {
    const { accessToken, member_id, report_id } = req.body;

    if (!member_id || !Number.isInteger(+member_id) || +member_id <= 0) {
      return res.status(400).json({ error: 'Invalid member_id' });
    }

    if (!report_id || !Number.isInteger(+report_id) || +report_id <= 0) {
      return res.status(400).json({ error: 'Invalid report_id' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded.' });
    }

    const { decodedToken } = await authintication(accessToken, member_id, connection);



    const report = await connection.queryOne(
      'SELECT user_id FROM reports WHERE id = $1 AND deleted = false',
      [report_id]
    );
    if (!report || report.user_id !== +member_id) {
      return res.status(403).json({ error: 'Report not found or does not belong to this member.' });
    }

    await connection.beginTransaction();

    const uploadFolder = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadFolder, { recursive: true });

    const processedImages = await processImages(req.files, decodedToken.userId);
    const invalidImages = [];

    for (let i = 0; i < processedImages.length; i++) {
      const { grayscale, color, thumbnail } = processedImages[i];
      const classificationResult = await classifyImage(grayscale.buffer);

      if (!classificationResult.isMedicalDocument) {
        invalidImages.push({ index: i, filename: grayscale.filename });
        continue;
      }

      const colorPath = path.join(uploadFolder, color.filename);
      const thumbPath = path.join(uploadFolder, thumbnail.filename);
      await fs.writeFile(colorPath, color.buffer);
      await fs.writeFile(thumbPath, thumbnail.buffer);

      await connection.query(
        `INSERT INTO report_images (report_id, resiged, thumb, created_at)
         VALUES ($1, $2, $3, CURRENT_DATE)`,
        [report_id, `/uploads/${color.filename}`, `/uploads/${thumbnail.filename}`]
      );
    }

    if (invalidImages.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Some images are invalid.', invalidImages });
    }

    await connection.commit();
    res.status(200).json({ message: 'Images appended successfully to report.' });
  } catch (error) {
    await connection.rollback();
    console.error("Error appending report images:", error);
    res.status(500).json({ error: 'An unknown error occurred.' });
  } finally {
    await connection.release();
  }
});
















app.post('/uploadProfile', upload.single('image'), async (req, res) => {

  const connection = await database.getConnection(); // Get DB connection
  try {
    const { accessToken, member_id } = req.body;
 // Check if files are uploaded
    if (!member_id) {
      return res.status(400).json({ error: 'Missing field!' });
    }
    if (!(Number.isInteger(+member_id) && +member_id > 0)) {
      return res.status(400).json({ error: 'invalid type!' });

    }
    // Decode token and verify user existence
   const {decodedToken,isExist}= await authintication(accessToken, member_id, connection);

   
    // Check if files are uploaded
    if (!req.file) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    await connection.beginTransaction(); // Start a transaction
    const processedImages = await processImages([req.file],decodedToken.userId);
    // const invalidImages = [];
    const uploadFolder = path.join(__dirname, 'profiles');

    await fs.mkdir(uploadFolder, { recursive: true });



      const {  color } = processedImages[0];

  
      // Save color image for frontend
      const colorPath = path.join(uploadFolder, color.filename);
      await fs.writeFile(colorPath, color.buffer);

   await connection.queryOne(
      `UPDATE users SET profile_image_url = $1 WHERE user_id = $2`,
      [`/profiles/${color.filename}`, member_id]
    );


    // Delete previous profile image if exists
if (isExist.profile_image_url) {
  const previousPath = path.join(__dirname, isExist.profile_image_url);
  try {
    await fs.unlink(previousPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to delete previous image:', err);
      throw new Error('Error deleting old profile image.');
    }
    // ENOENT means file doesn't exist, which is fine
  }
}


    await connection.commit(); // Commit transaction
    res.status(200).json({ message: 'Profile pic uploaded successfully.' });
  } catch (error) {

    await connection.rollback();

    if (error instanceof multer.MulterError) {

    
      if (error.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'You can only upload a maximum of 10 files.' });
      } else if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds the limit.' });
      }
    } else if (error.message === 'Access token is required.' || error.message === 'Invalid or expired access token.' || error.message === 'Invalid user.') {
      return res.status(403).json({ error: error.message });
    } else {
      return res.status(500).json({ error: 'An unknown error occurred.' });
    }

    console.error('Error processing images:', error);
  } finally {
    await connection.release(); // Release DB connection
  }
});


console.log("hi");

app.listen(port, () => {
  console.log(`🚀 Server is up and running on http://localhost:${port}`);
});