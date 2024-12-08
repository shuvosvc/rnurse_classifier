const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

const app = express();
const PORT = 3000;

// Multer setup for file uploads
const upload = multer({
    dest: './uploads'
});

// Function to classify images (dummy logic for now)
async function classifyImage(filePath) {
    // Placeholder: Replace with a proper ML model or logic
    const isMedical = Math.random() > 0.5; // Simulated 50% chance
    return isMedical;
}

// OCR function using Tesseract
async function extractText(filePath) {
    try {
        const result = await Tesseract.recognize(filePath, 'eng');
        return result.data.text;
    } catch (error) {
        console.error(`Error in OCR: ${error}`);
        throw error;
    }
}

// Upload endpoint
app.post('/upload', upload.array('images'), async (req, res) => {
    const files = req.files;

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const medicalFiles = [];
    for (const file of files) {
        const filePath = path.resolve(file.path);
        const isMedical = await classifyImage(filePath);

        if (!isMedical) {
            // Cleanup and return error if any file is not medical
            files.forEach(f => fs.unlinkSync(f.path));
            return res.status(400).json({ error: 'One or more files are not medical documents.' });
        }

        medicalFiles.push(filePath);
    }

    // Move files to permanent storage folder
    const storageDir = path.join(__dirname, 'uploads', 'medical_docs');
    if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
    }

    const savedFiles = [];
    for (const filePath of medicalFiles) {
        const fileName = path.basename(filePath);
        const newFilePath = path.join(storageDir, fileName);
        fs.renameSync(filePath, newFilePath);
        savedFiles.push(newFilePath);
    }

    res.json({ message: 'Files uploaded and classified successfully', files: savedFiles });
});

// Extract endpoint
app.post('/extract', async (req, res) => {
    const storageDir = path.join(__dirname, 'uploads', 'medical_docs');

    if (!fs.existsSync(storageDir)) {
        return res.status(400).json({ error: 'No medical documents found to extract.' });
    }

    const files = fs.readdirSync(storageDir);
    const extractionResults = {};

    for (const file of files) {
        const filePath = path.join(storageDir, file);
        try {
            const text = await extractText(filePath);
            extractionResults[file] = text;
        } catch (error) {
            extractionResults[file] = `Error extracting text: ${error.message}`;
        }
    }

    res.json({ message: 'Extraction complete', data: extractionResults });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});