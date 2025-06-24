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
// app.use('/profiles', authfilereq, express.static(path.join(__dirname, 'profiles')));


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

// Handle uploads
app.post('/uploadPrescription', upload.array('image'), async (req, res) => {

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
   const {decodedToken}= await authintication(accessToken, member_id, connection);

   
    // Check if files are uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    await connection.beginTransaction(); // Start a transaction
    const processedImages = await processImages(req.files,decodedToken.userId);
    const invalidImages = [];
    const uploadFolder = path.join(__dirname, 'uploads');

    await fs.mkdir(uploadFolder, { recursive: true });

    for (let i = 0; i < processedImages.length; i++) {
      const { grayscale, color, thumbnail } = processedImages[i];
      const classificationResult = await classifyImage(grayscale.buffer);

      if (!classificationResult.isMedicalDocument) {
        invalidImages.push({ index: i, filename: grayscale.filename });
        continue;
      }

      // Save color image for frontend
      const colorPath = path.join(uploadFolder, color.filename);
      await fs.writeFile(colorPath, color.buffer);

      // Save thumbnail image
      const thumbnailPath = path.join(uploadFolder, thumbnail.filename);
      await fs.writeFile(thumbnailPath, thumbnail.buffer);

      // Store image path in the database
      const query = 'INSERT INTO prescription (user_id, resized, thumbnail) VALUES ($1, $2, $3)';
      await connection.queryOne(query, [member_id, `/uploads/${color.filename}`, `/uploads/${thumbnail.filename}`]);
    }

    if (invalidImages.length > 0) {
      await connection.rollback(); // Rollback if invalid images are found
      return res.status(400).json({
        error: 'Some files are not medical documents.',
        invalidImages,
      });
    }

    await connection.commit(); // Commit transaction
    res.status(200).json({ message: 'All files processed successfully.' });
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


app.post('/uploadReport', upload.array('image'), async (req, res) => {

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
   const {decodedToken}= await authintication(accessToken, member_id, connection);

   
    // Check if files are uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    await connection.beginTransaction(); // Start a transaction
    const processedImages = await processImages(req.files,decodedToken.userId);
    const invalidImages = [];
    const uploadFolder = path.join(__dirname, 'uploads');

    await fs.mkdir(uploadFolder, { recursive: true });

    for (let i = 0; i < processedImages.length; i++) {
      const { grayscale, color, thumbnail } = processedImages[i];
      const classificationResult = await classifyImage(grayscale.buffer);

      if (!classificationResult.isMedicalDocument) {
        invalidImages.push({ index: i, filename: grayscale.filename });
        continue;
      }

      // Save color image for frontend
      const colorPath = path.join(uploadFolder, color.filename);
      await fs.writeFile(colorPath, color.buffer);

      // Save thumbnail image
      const thumbnailPath = path.join(uploadFolder, thumbnail.filename);
      await fs.writeFile(thumbnailPath, thumbnail.buffer);

      // Store image path in the database
      const query = 'INSERT INTO report (user_id, resized, thumbnail) VALUES ($1, $2, $3)';
      await connection.queryOne(query, [member_id, `/uploads/${color.filename}`, `/uploads/${thumbnail.filename}`]);
    }

    if (invalidImages.length > 0) {
      await connection.rollback(); // Rollback if invalid images are found
      return res.status(400).json({
        error: 'Some files are not medical documents.',
        invalidImages,
      });
    }

    await connection.commit(); // Commit transaction
    res.status(200).json({ message: 'All files processed successfully.' });
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



app.post('/uploadReport', upload.array('image'), async (req, res) => {
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

    if (!member_id || !Number.isInteger(+member_id) || +member_id <= 0) {
      return res.status(400).json({ error: 'Invalid or missing member_id' });
    }


// Validate required field
if (!member_id || !Number.isInteger(+member_id) || +member_id <= 0) {
  return res.status(400).json({ error: 'Invalid or missing member_id' });
}

// Optional: validate prescription_id
if (prescription_id !== undefined && (!Number.isInteger(+prescription_id) || +prescription_id <= 0)) {
  return res.status(400).json({ error: 'Invalid prescription_id' });
}

// Optional: validate shared
if (shared !== undefined && shared !== 'true' && shared !== 'false' && shared !== true && shared !== false) {
  return res.status(400).json({ error: 'Invalid shared value. Must be true or false' });
}

// Optional: validate test_name
if (test_name !== undefined && typeof test_name !== 'string') {
  return res.status(400).json({ error: 'test_name must be a string' });
}

// Optional: validate deliveryDate
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

    // Dynamically build insert for optional fields
    const fields = ['user_id'];
    const values = [member_id];
    const placeholders = ['$1'];
    let idx = 2;

    if (prescription_id) {
      fields.push('prescription_id');
      values.push(prescription_id);
      placeholders.push(`$${idx++}`);
    }

    if (shared !== undefined) {
      fields.push('shared');
      values.push(shared === 'true' || shared === true); // string to bool
      placeholders.push(`$${idx++}`);
    }

    if (test_name) {
      fields.push('test_name');
      values.push(test_name);
      placeholders.push(`$${idx++}`);
    }

    if (deliveryDate) {
      fields.push('delivery_date');
      values.push(deliveryDate); // Expecting 'YYYY-MM-DD'
      placeholders.push(`$${idx++}`);
    }

    fields.push('created_at');
    values.push('CURRENT_DATE');
    placeholders.push('CURRENT_DATE');

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