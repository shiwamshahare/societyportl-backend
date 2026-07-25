const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const memberSchema = Joi.object({
  society_id: Joi.string().required(),
  wing_id: Joi.string().optional(),
  flat_id: Joi.string().optional(),
  relationship_with_head: Joi.string().default('self').valid('self', 'spouse', 'child', 'parent', 'relative', 'other'),
  blood_group: Joi.string().valid('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-').optional(),
  date_of_birth: Joi.date().iso().optional(),
  gender: Joi.string().valid('male', 'female', 'other').optional(),
  emergency_contact_name: Joi.string().max(255).optional(),
  emergency_contact_phone: Joi.string().max(20).optional(),
  vehicle_number: Joi.string().max(20).optional(),
  vehicle_type: Joi.string().max(50).optional(),
  pet_details: Joi.string().max(500).optional(),
  occupation: Joi.string().max(100).optional(),
  annual_income: Joi.number().precision(2).min(0).optional()
});

// Get all members
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(
      `SELECT m.id, m.profile_id, m.society_id, m.wing_id, m.flat_id, m.relationship_with_head, m.blood_group,
              m.date_of_birth, m.gender, m.emergency_contact_name, m.emergency_contact_phone,
              m.vehicle_number, m.vehicle_type, m.pet_details, m.occupation, m.annual_income,
              m.is_approved, m.approval_date, m.approved_by, m.created_at, m.updated_at,
              p.full_name, p.email, p.phone,
              s.name as society_name,
              w.name as wing_name,
              f.flat_number
       FROM members m
       JOIN profiles p ON m.profile_id = p.id
       LEFT JOIN societies s ON m.society_id = s.id
       LEFT JOIN wings w ON m.wing_id = w.id
       LEFT JOIN flats f ON m.flat_id = f.id
       ORDER BY s.name, w.name, f.flat_number, p.full_name`
    );

    res.status(200).json({
      success: true,
      data: {
        members: result.rows
      }
    });
  } catch (error) {
    console.error('Get members error:', error);
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

// Get members by society ID
router.get('/society/:societyId', authenticateToken, async (req, res) => {
  let client;
  try {
    const { societyId } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT m.id, m.profile_id, m.society_id, m.wing_id, m.flat_id, m.relationship_with_head, m.blood_group,
              m.date_of_birth, m.gender, m.emergency_contact_name, m.emergency_contact_phone,
              m.vehicle_number, m.vehicle_type, m.pet_details, m.occupation, m.annual_income,
              m.is_approved, m.approval_date, m.approved_by, m.created_at, m.updated_at,
              p.full_name, p.email, p.phone,
              s.name as society_name,
              w.name as wing_name,
              f.flat_number
       FROM members m
       JOIN profiles p ON m.profile_id = p.id
       LEFT JOIN societies s ON m.society_id = s.id
       LEFT JOIN wings w ON m.wing_id = w.id
       LEFT JOIN flats f ON m.flat_id = f.id
       WHERE m.society_id = $1
       ORDER BY w.name, f.flat_number, p.full_name`,
      [societyId]
    );

    res.status(200).json({
      success: true,
      data: {
        members: result.rows
      }
    });
  } catch (error) {
    console.error('Get members by society error:', error);
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

// Get member by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();

    const result = await client.query(
      `SELECT m.id, m.profile_id, m.society_id, m.wing_id, m.flat_id, m.relationship_with_head, m.blood_group,
              m.date_of_birth, m.gender, m.emergency_contact_name, m.emergency_contact_phone,
              m.vehicle_number, m.vehicle_type, m.pet_details, m.occupation, m.annual_income,
              m.is_approved, m.approval_date, m.approved_by, m.created_at, m.updated_at,
              p.full_name, p.email, p.phone,
              s.name as society_name,
              w.name as wing_name,
              f.flat_number
       FROM members m
       JOIN profiles p ON m.profile_id = p.id
       LEFT JOIN societies s ON m.society_id = s.id
       LEFT JOIN wings w ON m.wing_id = w.id
       LEFT JOIN flats f ON m.flat_id = f.id
       WHERE m.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        member: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get member by ID error:', error);
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

// Create a new member
router.post('/', authenticateToken, authorizeRole('admin', 'resident'), async (req, res) => {
  let client;
  try {
    const { error, value } = memberSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // For simplicity, we'll use the authenticated user's profile
    // In a real app, this might be different if admins are adding members for others
    const profileId = req.user.userId; // Assuming user ID matches profile ID for simplicity

    client = await pool.connect();
    await client.query('BEGIN');

    // Verify society exists
    const societyCheck = await client.query(
      'SELECT id FROM societies WHERE id = $1',
      [value.society_id]
    );

    if (societyCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Society not found'
      });
    }

    // Check if wing exists (if provided)
    if (value.wing_id) {
      const wingCheck = await client.query(
        'SELECT id FROM wings WHERE id = $1 AND society_id = $2',
        [value.wing_id, value.society_id]
      );

      if (wingCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Wing not found or does not belong to this society'
        });
      }
    }

    // Check if flat exists (if provided)
    if (value.flat_id) {
      const flatCheck = await client.query(
        `SELECT f.id FROM flats f
         JOIN wings w ON f.wing_id = w.id
         WHERE f.id = $1 AND w.society_id = $2`,
        [value.flat_id, value.society_id]
      );

      if (flatCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Flat not found or does not belong to this society'
        });
      }
    }

    // Check if member already exists for this profile and society
    const existingMember = await client.query(
      'SELECT id FROM members WHERE profile_id = $1 AND society_id = $2',
      [profileId, value.society_id]
    );

    if (existingMember.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Member already exists for this society'
      });
    }

    const result = await client.query(
      `INSERT INTO members (profile_id, society_id, wing_id, flat_id, relationship_with_head, blood_group,
              date_of_birth, gender, emergency_contact_name, emergency_contact_phone,
              vehicle_number, vehicle_type, pet_details, occupation, annual_income, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id, profile_id, society_id, wing_id, flat_id, relationship_with_head, blood_group,
                 date_of_birth, gender, emergency_contact_name, emergency_contact_phone,
                 vehicle_number, vehicle_type, pet_details, occupation, annual_income,
                 is_approved, approval_date, approved_by, created_at, updated_at`,
      [
        profileId,
        value.society_id,
        value.wing_id || null,
        value.flat_id || null,
        value.relationship_with_head,
        value.blood_group || null,
        value.date_of_birth || null,
        value.gender || null,
        value.emergency_contact_name || null,
        value.emergency_contact_phone || null,
        value.vehicle_number || null,
        value.vehicle_type || null,
        value.pet_details || null,
        value.occupation || null,
        value.annual_income || null,
        req.user.userId
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Member added successfully',
      data: {
        member: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create member error:', error);
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

// Update member
router.put('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = memberSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if member exists
    const checkResult = await client.query('SELECT profile_id, society_id FROM members WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    const { profile_id, society_id } = checkResult.rows[0];

    // Verify society exists
    const societyCheck = await client.query(
      'SELECT id FROM societies WHERE id = $1',
      [society_id]
    );

    if (societyCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Society not found'
      });
    }

    // Validate wing belongs to society (if provided)
    if (value.wing_id) {
      const wingCheck = await client.query(
        'SELECT id FROM wings WHERE id = $1 AND society_id = $2',
        [value.wing_id, society_id]
      );

      if (wingCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Wing not found or does not belong to this society'
        });
      }
    }

    // Validate flat belongs to society (if provided)
    if (value.flat_id) {
      const flatCheck = await client.query(
        `SELECT f.id FROM flats f
         JOIN wings w ON f.wing_id = w.id
         WHERE f.id = $1 AND w.society_id = $2`,
        [value.flat_id, society_id]
      );

      if (flatCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Flat not found or does not belong to this society'
        });
      }
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

    // Add member ID for WHERE clause
    values.push(id);

    const queryText = `
      UPDATE members
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, profile_id, society_id, wing_id, flat_id, relationship_with_head, blood_group,
                date_of_birth, gender, emergency_contact_name, emergency_contact_phone,
                vehicle_number, vehicle_type, pet_details, occupation, annual_income,
                is_approved, approval_date, approved_by, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Member updated successfully',
      data: {
        member: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update member error:', error);
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

// Approve member (admin only)
router.patch('/:id/approve', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if member exists
    const memberCheck = await client.query(
      'SELECT id, profile_id FROM members WHERE id = $1',
      [id]
    );

    if (memberCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    // Update member approval status
    await client.query(
      `UPDATE members
       SET is_approved = true, approval_date = NOW(), approved_by = $1, updated_at = NOW()
       WHERE id = $2`,
      [req.user.userId, id]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Member approved successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Approve member error:', error);
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

// Delete member
router.delete('/:id', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if member exists
    const checkResult = await client.query('SELECT id FROM members WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    // Delete member
    await client.query('DELETE FROM members WHERE id = $1', [id]);

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Member deleted successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Delete member error:', error);
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