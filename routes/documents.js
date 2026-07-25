const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const documentSchema = Joi.object({
  society_id: Joi.string().optional(),
  uploaded_by: Joi.string().required(),
  related_to_uuid: Joi.string().optional(),
  related_to_type: Joi.string().optional().max(50),
  file_name: Joi.string().required().min(1).max(255),
  file_path: Joi.string().required().min(1).max(500),
  file_size: Joi.number().integer().min(0),
  file_type: Joi.string().optional().max(100),
  description: Joi.string().optional(),
  is_public: Joi.boolean().default(false),
  access_level: Joi.string().valid('private', 'society', 'public').default('private')
});

// Get all documents
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT d.id, d.society_id, d.uploaded_by, d.related_to_uuid, d.related_to_type, d.file_name, d.file_path,
              d.file_size, d.file_type, d.description, d.is_public, d.access_level, d.created_at, d.updated_at,
              s.name as society_name,
              uploader.full_name as uploaded_by_name
       FROM documents d
       LEFT JOIN societies s ON d.society_id = s.id
       JOIN profiles uploader ON d.uploaded_by = uploader.id
       ORDER BY d.created_at DESC`
    );

    res.status(200).json({
      success: true,
      data: {
        documents: result.rows
      }
    });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Get documents by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT d.id, d.society_id, d.uploaded_by, d.related_to_uuid, d.related_to_type, d.file_name, d.file_path,
              d.file_size, d.file_type, d.description, d.is_public, d.access_level, d.created_at, d.updated_at,
              s.name as society_name,
              uploader.full_name as uploaded_by_name
       FROM documents d
       JOIN societies s ON d.society_id = s.id
       JOIN profiles uploader ON d.uploaded_by = uploader.id
       WHERE d.society_id = $1
       ORDER BY d.created_at DESC`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        documents: result.rows
      }
    });
  } catch (error) {
    console.error('Get documents by society error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Get document by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT d.id, d.society_id, d.uploaded_by, d.related_to_uuid, d.related_to_type, d.file_name, d.file_path,
              d.file_size, d.file_type, d.description, d.is_public, d.access_level, d.created_at, d.updated_at,
              s.name as society_name,
              uploader.full_name as uploaded_by_name
       FROM documents d
       LEFT JOIN societies s ON d.society_id = s.id
       JOIN profiles uploader ON d.uploaded_by = uploader.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        document: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get document by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Create a new document
router.post('/', authenticateToken, async (req, res) => {
  let client;
  try {
    const { error, value } = documentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Verify society exists (if provided)
    if (value.society_id) {
      const societyCheck = await client.query(
        'SELECT id FROM societies WHERE id = $1',
        [value.society_id]
      );

      if (societyCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Society not found'
        });
      }
    }

    // Verify uploader exists
    const uploaderCheck = await client.query(
      'SELECT id FROM profiles WHERE id = $1',
      [value.uploaded_by]
    );

    if (uploaderCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Uploader not found'
      });
    }

    const result = await client.query(
      `INSERT INTO documents (society_id, uploaded_by, related_to_uuid, related_to_type, file_name, file_path,
              file_size, file_type, description, is_public, access_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, society_id, uploaded_by, related_to_uuid, related_to_type, file_name, file_path,
                 file_size, file_type, description, is_public, access_level, created_at, updated_at`,
      [
        value.society_id || null,
        value.uploaded_by,
        value.related_to_uuid || null,
        value.related_to_type || null,
        value.file_name,
        value.file_path,
        value.file_size,
        value.file_type || null,
        value.description || null,
        value.is_public,
        value.access_level,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: {
        document: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create document error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Update document
router.put('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = documentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if document exists
    const checkResult = await client.query('SELECT id FROM documents WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Document not found'
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let index = 1;

    Object.keys(value).forEach(key => {
      if (value[key] !== undefined) {
        updates.push(`${key} = $${index}`);
        values.push(value[key]);
        index++;
      }
    });

    // Handle null values for optional fields
    const nullableFields = ['society_id', 'related_to_uuid', 'related_to_type', 'description', 'file_type'];
    nullableFields.forEach(field => {
      if (value[field] === null && !updates.some(u => u.startsWith(`${field} =`))) {
        updates.push(`${field} = $${index}`);
        values.push(null);
        index++;
      }
    });

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    // Add updated_at timestamp
    updates.push(`updated_at = $${index}`);
    values.push(new Date());
    index++;

    // Add document ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE documents
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, society_id, uploaded_by, related_to_uuid, related_to_type, file_name, file_path,
                file_size, file_type, description, is_public, access_level, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Document updated successfully',
      data: {
        document: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update document error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Delete document
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if document exists
    const checkResult = await client.query('SELECT id FROM documents WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Document not found'
      });
    }

    // Delete document
    await client.query('DELETE FROM documents WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Document deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete document error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Get user's documents
router.get('/my-documents', authenticateToken, async (req, res) => {
  let client;
  try {
    const userId = req.user.userId;

    client = await pool.connect();

    const result = await client.query(
      `SELECT d.id, d.society_id, d.uploaded_by, d.related_to_uuid, d.related_to_type, d.file_name, d.file_path,
              d.file_size, d.file_type, d.description, d.is_public, d.access_level, d.created_at, d.updated_at,
              s.name as society_name,
              uploader.full_name as uploaded_by_name
       FROM documents d
       LEFT JOIN societies s ON d.society_id = s.id
       JOIN profiles uploader ON d.uploaded_by = uploader.id
       WHERE d.uploaded_by = $1
       ORDER BY d.created_at DESC`,
      [userId]
    );

    res.status(200).json({
      success: true,
      data: {
        documents: result.rows
      }
    });
  } catch (error) {
    console.error('Get user documents error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;