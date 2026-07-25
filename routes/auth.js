const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { hashPassword, comparePassword, generateToken, verifyToken, extractToken, authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  full_name: Joi.string().optional(),
  name: Joi.string().optional(),
  phone: Joi.string().allow('', null).optional(),
  role: Joi.string().valid('resident', 'guard', 'admin').default('resident'),
  gender: Joi.string().optional(),
  dob: Joi.string().optional(),
  flatNumber: Joi.string().optional(),
  tower: Joi.string().optional(),
  societyName: Joi.string().optional(),
  onboardingDetails: Joi.object().optional()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

// Check phone endpoint
router.post('/check-phone', async (req, res) => {
  let client;
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    client = await pool.connect();
    const userCheck = await client.query(
      'SELECT id, email, full_name as name, phone, role FROM profiles WHERE phone = $1',
      [phone]
    );

    if (userCheck.rows.length > 0) {
      return res.json({ exists: true, user: userCheck.rows[0] });
    }
    return res.json({ exists: false });
  } catch (error) {
    console.error('Check phone error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

// Check email endpoint
router.post('/check-email', async (req, res) => {
  let client;
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email address is required' });
    }

    client = await pool.connect();
    const userCheck = await client.query(
      'SELECT id FROM profiles WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    return res.json({ exists: userCheck.rows.length > 0 });
  } catch (error) {
    console.error('Check email error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

// Send OTP endpoint
router.post('/send-otp', async (req, res) => {
  const devOtp = '123456';
  return res.json({
    success: true,
    message: 'OTP sent successfully',
    devOtp
  });
});

// Verify OTP endpoint
router.post('/verify-otp', async (req, res) => {
  let client;
  try {
    const { phone, email, token } = req.body;
    if (token !== '123456') {
      return res.status(400).json({ success: false, message: 'Invalid verification code' });
    }

    client = await pool.connect();
    let userResult;

    if (phone) {
      userResult = await client.query(
        'SELECT id, email, full_name as name, phone, role FROM profiles WHERE phone = $1',
        [phone]
      );
    } else if (email) {
      userResult = await client.query(
        'SELECT id, email, full_name as name, phone, role FROM profiles WHERE LOWER(email) = LOWER($1)',
        [email]
      );
    }

    if (userResult && userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const authToken = generateToken({ userId: user.id, email: user.email, role: user.role });
      return res.json({ success: true, user, token: authToken });
    }

    return res.json({ success: true, message: 'OTP verified' });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

// Google OAuth simulation
router.post('/google', async (req, res) => {
  return res.json({
    success: true,
    user: {
      id: 'google-user-' + Date.now(),
      email: 'user@google.com',
      name: 'Google User',
      role: 'resident'
    }
  });
});

// Complete Profile endpoint
router.put('/complete-profile', async (req, res) => {
  let client;
  try {
    const { userId, name, phone, role, gender, dob, onboardingDetails } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    client = await pool.connect();
    const result = await client.query(
      `UPDATE profiles
       SET full_name = COALESCE($1, full_name),
           phone = COALESCE($2, phone),
           role = COALESCE($3, role),
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, full_name as name, phone, role`,
      [name, phone, role, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Complete profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

// Save Onboarding details endpoint - stores into separate society_onboardings table
router.post('/save-onboarding', async (req, res) => {
  let client;
  try {
    const {
      userId,
      onboardingType,
      city,
      societyName,
      wing,
      flat,
      company,
      role,
      managerName,
      managerPhone,
      societyDescription,
      idProofType,
      idProofFront,
      idProofBack,
      ownerDocType,
      ownerDocument,
      tenantNocFile,
      tenantRentFile,
      tenantTenureEndDate,
    } = req.body;

    client = await pool.connect();

    // Defensively ensure society_onboardings table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS society_onboardings (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
          onboarding_type VARCHAR(50) DEFAULT 'society_listing',
          city VARCHAR(100),
          society_name VARCHAR(255) NOT NULL,
          wing VARCHAR(100),
          flat VARCHAR(50),
          company VARCHAR(255),
          role VARCHAR(50),
          manager_name VARCHAR(255),
          manager_phone VARCHAR(50),
          society_description TEXT,
          id_proof_type VARCHAR(100),
          id_proof_front BOOLEAN DEFAULT FALSE,
          id_proof_back BOOLEAN DEFAULT FALSE,
          owner_doc_type VARCHAR(100),
          owner_document TEXT,
          tenant_noc_file TEXT,
          tenant_rent_file TEXT,
          tenant_tenure_end_date VARCHAR(100),
          status VARCHAR(50) DEFAULT 'pending',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const result = await client.query(
      `INSERT INTO society_onboardings (
        profile_id, onboarding_type, city, society_name, wing, flat, company, role,
        manager_name, manager_phone, society_description, id_proof_type,
        id_proof_front, id_proof_back, owner_doc_type, owner_document,
        tenant_noc_file, tenant_rent_file, tenant_tenure_end_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING *`,
      [
        userId || null,
        onboardingType || 'society_listing',
        city || null,
        societyName || 'Unspecified Society',
        wing || null,
        flat || null,
        company || null,
        role || null,
        managerName || null,
        managerPhone || null,
        societyDescription || null,
        idProofType || null,
        idProofFront || false,
        idProofBack || false,
        ownerDocType || null,
        ownerDocument || null,
        tenantNocFile || null,
        tenantRentFile || null,
        tenantTenureEndDate || null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Society onboarding request saved successfully to society_onboardings table',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Save onboarding error:', error);
    res.status(500).json({ success: false, message: 'Server error saving onboarding details' });
  } finally {
    if (client) client.release();
  }
});

// Get all society onboarding entries
router.get('/onboardings', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT * FROM society_onboardings ORDER BY created_at DESC');
    res.json({ success: true, data: { onboardings: result.rows } });
  } catch (error) {
    console.error('Get onboardings error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching onboarding requests' });
  } finally {
    if (client) client.release();
  }
});

// Logout endpoint
router.post('/logout', async (req, res) => {
  return res.json({ success: true, message: 'Logged out successfully' });
});

// Register a new user
router.post('/register', async (req, res) => {
  let client;
  try {
    // Validate input
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const email = value.email;
    const password = value.password;
    const fullName = value.full_name || value.name || 'User';
    const phone = value.phone || null;
    const role = value.role || 'resident';

    client = await pool.connect();

    // Start transaction
    await client.query('BEGIN');

    // Check if user already exists
    const userCheck = await client.query(
      'SELECT id FROM profiles WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (userCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'User already exists with this email'
      });
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Insert user profile
    const userResult = await client.query(
      `INSERT INTO profiles (email, password_hash, full_name, phone, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, full_name, phone, role, created_at`,
      [email, passwordHash, fullName, phone, role]
    );

    const user = userResult.rows[0];

    // If onboarding details / society details provided, insert into separate society_onboardings table
    const ob = value.onboardingDetails || {};
    const socName = value.societyName || ob.societyName;
    if (socName) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS society_onboardings (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
            onboarding_type VARCHAR(50) DEFAULT 'society_listing',
            city VARCHAR(100),
            society_name VARCHAR(255) NOT NULL,
            wing VARCHAR(100),
            flat VARCHAR(50),
            company VARCHAR(255),
            role VARCHAR(50),
            manager_name VARCHAR(255),
            manager_phone VARCHAR(50),
            society_description TEXT,
            id_proof_type VARCHAR(100),
            id_proof_front BOOLEAN DEFAULT FALSE,
            id_proof_back BOOLEAN DEFAULT FALSE,
            owner_doc_type VARCHAR(100),
            owner_document TEXT,
            tenant_noc_file TEXT,
            tenant_rent_file TEXT,
            tenant_tenure_end_date VARCHAR(100),
            status VARCHAR(50) DEFAULT 'pending',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(
        `INSERT INTO society_onboardings (
          profile_id, onboarding_type, city, society_name, wing, flat, company, role,
          manager_name, manager_phone, society_description, id_proof_type,
          id_proof_front, id_proof_back, owner_doc_type, owner_document,
          tenant_noc_file, tenant_rent_file, tenant_tenure_end_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          user.id,
          ob.onboardingType || 'residential',
          ob.city || null,
          socName,
          value.tower || ob.wing || null,
          value.flatNumber || ob.flat || null,
          ob.company || null,
          role,
          ob.managerName || null,
          ob.managerPhone || null,
          ob.societyDescription || null,
          ob.idProofType || null,
          ob.idProofFront || false,
          ob.idProofBack || false,
          ob.ownerDocType || null,
          ob.ownerDocument || null,
          ob.tenantNocFile || null,
          ob.tenantRentFile || null,
          ob.tenantTenureEndDate || null,
        ]
      );
    }

    // Generate token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role
    });

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          name: user.full_name,
          phone: user.phone,
          role: user.role,
          societyName: value.societyName || '',
          tower: value.tower || '',
          flatNumber: value.flatNumber || '',
          gender: value.gender || '',
          dob: value.dob || ''
        },
        token
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Registration error:', error);
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

// Login user
router.post('/login', async (req, res) => {
  let client;
  try {
    // Validate input
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { email, password } = value;
    client = await pool.connect();

    // Find user by email
    const userResult = await client.query(
      'SELECT id, email, password_hash, full_name, phone, role, status FROM profiles WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const user = userResult.rows[0];

    // Check account status
    if (user.status !== 'active') {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated or suspended'
      });
    }

    // Compare password
    const isValidPassword = await comparePassword(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Update last login time
    await client.query(
      'UPDATE profiles SET last_login_at = NOW() WHERE id = $1',
      [user.id]
    );

    // Generate token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role
    });

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = user;

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: userWithoutPassword,
        token
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Login error:', error);
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

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const userResult = await client.query(
      'SELECT id, email, full_name, phone, role, status, avatar_url, email_verified, phone_verified, created_at, last_login_at FROM profiles WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        user: userResult.rows[0]
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
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

// Update user profile
router.put('/me', authenticateToken, async (req, res) => {
  let client;
  try {
    // Validate input
    const updateSchema = Joi.object({
      full_name: Joi.string().optional(),
      phone: Joi.string().optional(),
      avatar_url: Joi.string().uri().optional()
    });

    const { error, value } = updateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if user exists
    const userCheck = await client.query(
      'SELECT id FROM profiles WHERE id = $1',
      [req.user.userId]
    );

    if (userCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
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

    // Add user ID for WHERE clause
    values.push(req.user.userId);

    const queryText = `
      UPDATE profiles
      SET ${updates.join(', ')}
      WHERE id = $${index}
      RETURNING id, email, full_name, phone, role, status, avatar_url, email_verified, phone_verified, created_at, updated_at
    `;

    const result = await client.query(queryText, values);
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update profile error:', error);
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

// Change password
router.put('/change-password', authenticateToken, async (req, res) => {
  let client;
  try {
    const passwordSchema = Joi.object({
      current_password: Joi.string().required(),
      new_password: Joi.string().min(6).required()
    });

    const { error, value } = passwordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { current_password, new_password } = value;
    client = await pool.connect();

    // Get current user with password hash
    const userResult = await client.query(
      'SELECT password_hash FROM profiles WHERE id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = userResult.rows[0];

    // Verify current password
    const isValidPassword = await comparePassword(current_password, user.password_hash);
    if (!isValidPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const newPasswordHash = await hashPassword(new_password);

    // Update password
    await client.query(
      'UPDATE profiles SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newPasswordHash, req.user.userId]
    );

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Change password error:', error);
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

// Admin: Get all users (protected)
router.get('/users', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const usersResult = await client.query(
      'SELECT id, email, full_name, phone, role, status, avatar_url, created_at, last_login_at FROM profiles ORDER BY created_at DESC'
    );

    res.status(200).json({
      success: true,
      data: {
        users: usersResult.rows
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
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

// Admin: Update user status
router.put('/users/:userId/status', authenticateToken, authorizeRole('admin'), async (req, res) => {
  let client;
  try {
    const { userId } = req.params;
    const { status } = req.body;

    // Validate status
    const validStatuses = ['active', 'inactive', 'suspended'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be active, inactive, or suspended'
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if user exists
    const userCheck = await client.query(
      'SELECT id FROM profiles WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user status
    await client.query(
      'UPDATE profiles SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, userId]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: `User status updated to ${status}`
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update user status error:', error);
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