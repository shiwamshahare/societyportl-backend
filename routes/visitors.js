const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { pool } = require('../config/database');
const { authenticateToken, authorizeRole } = require('../middleware/auth');

// Validation schemas
const visitorSchema = Joi.object({
  name: Joi.string().required().min(2).max(255),
  phone: Joi.string().optional().max(20),
  photoUrl: Joi.string().uri().optional(),
  type: Joi.string().valid('GUEST', 'DELIVERY', 'CAB', 'SERVICE').default('GUEST')
});

const visitorRequestSchema = Joi.object({
  purpose: Joi.string().required(),
  flatId: Joi.string().required(),
  visitorId: Joi.string().required(),
  requestedById: Joi.string().required()
});

const visitorRequestUpdateSchema = Joi.object({
  status: Joi.string().valid('APPROVED', 'REJECTED').required()
});

const entryLogSchema = Joi.object({
  visitorRequestId: Joi.string().required(),
  processedById: Joi.string().required()
});

// Get all visitors
router.get('/', authenticateToken, async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    const result = await client.query(`
      SELECT v.*,
             vr.id as "visitorRequestId", vr.status as "requestStatus", vr.purpose,
             vr."requestedAt", vr."resolvedAt", vr."entryTime", vr."exitTime",
             el.id as "entryLogId", el."entryTime" as "logEntryTime", el."exitTime" as "logExitTime",
             f."flatNumber", w.name as "wingName", s.name as "societyName",
             reqBy."fullName" as "requestedByName",
             procBy."fullName" as "processedByName"
      FROM "Visitor" v
      LEFT JOIN "VisitorRequest" vr ON v.id = vr."visitorId"
      LEFT JOIN "EntryLog" el on vr.id = el."visitorRequestId"
      LEFT JOIN flats f ON vr."flatId" = f.id
      LEFT JOIN wings w ON f."wingId" = w.id
      LEFT JOIN societies s ON w."societyId" = s.id
      LEFT JOIN profiles reqBy ON vr."requestedById" = reqBy.id
      LEFT JOIN profiles procBy ON vr."processedById" = procBy.id
      ORDER BY v."createdAt" DESC
    `);

    res.status(200).json({
      success: true,
      data: {
        visitors: result.rows
      }
    });
  } catch (error) {
    console.error('Get visitors error:', error);
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

// Get visitor by ID
router.get('/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    client = await pool.connect();

    const result = await client.query(`
      SELECT v.*,
             vr.id as "visitorRequestId", vr.status as "requestStatus", vr.purpose,
             vr."requestedAt", vr."resolvedAt", vr."entryTime", vr."exitTime",
             el.id as "entryLogId", el."entryTime" as "logEntryTime", el."exitTime" as "logExitTime",
             f."flatNumber", w.name as "wingName", s.name as "societyName",
             reqBy."fullName" as "requestedByName",
             procBy."fullName" as "processedByName"
      FROM "Visitor" v
      LEFT JOIN "VisitorRequest" vr ON v.id = vr."visitorId"
      LEFT JOIN "EntryLog" el on vr.id = el."visitorRequestId"
      LEFT JOIN flats f ON vr."flatId" = f.id
      LEFT JOIN wings w ON f."wingId" = w.id
      LEFT JOIN societies s ON w."societyId" = s.id
      LEFT JOIN profiles reqBy ON vr."requestedById" = reqBy.id
      LEFT JOIN profiles procBy ON vr."processedById" = procBy.id
      WHERE v.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Visitor not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        visitor: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get visitor by ID error:', error);
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

// Create a new visitor
router.post('/', authenticateToken, authorizeRole('guard'), async (req, res) => {
  let client;
  try {
    const { error, value } = visitorSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO "Visitor" (name, phone, "photoUrl", type)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, phone, "photoUrl", type, "createdAt"`,
      [value.name, value.phone || null, value.photoUrl || null, value.type]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Visitor created successfully',
      data: {
        visitor: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create visitor error:', error);
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

// Create a new visitor request (guard registers visitor)
router.post('/request', authenticateToken, authorizeRole('guard'), async (req, res) => {
  let client;
  try {
    const { error, value } = visitorRequestSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Verify flat exists
    const flatCheck = await client.query(
      'SELECT f.id, f."flatNumber", w.name as "wingName", s.name as "societyName" FROM flats f JOIN wings w ON f."wingId" = w.id JOIN societies s ON w."societyId" = s.id WHERE f.id = $1',
      [value.flatId]
    );

    if (flatCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Flat not found'
      });
    }

    // Verify visitor exists
    const visitorCheck = await client.query(
      'SELECT id, name, phone, "photoUrl", type FROM "Visitor" WHERE id = $1',
      [value.visitorId]
    );

    if (visitorCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Visitor not found'
      });
    }

    // Verify requesting user is a guard
    const guardCheck = await client.query(
      'SELECT id, "fullName", role FROM profiles WHERE id = $1 AND role = $2',
      [value.requestedById, 'guard']
    );

    if (guardCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'Only guards can create visitor requests'
      });
    }

    const result = await client.query(
      `INSERT INTO "VisitorRequest" ("purpose", "flatId", "visitorId", "requestedById")
       VALUES ($1, $2, $3, $4)
       RETURNING id, "purpose", "flatId", "visitorId", "requestedById", "requestedAt", status`,
      [value.purpose, value.flatId, value.visitorId, value.requestedById]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Visitor request created successfully',
      data: {
        visitorRequest: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Create visitor request error:', error);
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

// Get visitor requests (for residents to see pending requests for their flat)
router.get('/requests', authenticateToken, async (req, res) => {
  let client;
  try {
    const { status, flatId } = req.query;
    let query = `
      SELECT vr.*,
             v.name as "visitorName", v.phone as "visitorPhone", v."photoUrl", v.type,
             f."flatNumber", w.name as "wingName", s.name as "societyName",
             reqBy."fullName" as "requestedByName",
             procBy."fullName" as "processedByName"
      FROM "VisitorRequest" vr
      JOIN "Visitor" v ON vr."visitorId" = v.id
      JOIN flats f ON vr."flatId" = f.id
      JOIN wings w ON f."wingId" = w.id
      JOIN societies s ON w."societyId" = s.id
      LEFT JOIN profiles reqBy ON vr."requestedById" = reqBy.id
      LEFT JOIN profiles procBy ON vr."processedById" = procBy.id
      WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND vr.status = $${paramIndex++}`;
      values.push(status);
    }

    if (flatId) {
      query += ` AND vr."flatId" = $${paramIndex++}`;
      values.push(flatId);
    }

    // For residents, only show requests for their flats
    if (req.user.role === 'resident') {
      // Get the flat ID for the resident
      const memberResult = await client.query(
        'SELECT f.id FROM members m JOIN flats f ON m."flatId" = f.id WHERE m."profileId" = $1',
        [req.user.id]
      );

      if (memberResult.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'User not associated with any flat'
        });
      }

      query += ` AND vr."flatId" = $${paramIndex++}`;
      values.push(memberResult.rows[0].id);
    }

    query += ` ORDER BY vr."requestedAt" DESC`;

    const result = await client.query(query, values);

    res.status(200).json({
      success: true,
      data: {
        visitorRequests: result.rows
      }
    });
  } catch (error) {
    console.error('Get visitor requests error:', error);
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

// Update visitor request status (approve/reject by resident)
router.patch('/request/:id', authenticateToken, async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = visitorRequestUpdateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if visitor request exists and get details
    const requestCheck = await client.query(
      `SELECT vr.*, v.name as "visitorName", f."flatNumber", w.name as "wingName", s.name as "societyName",
              reqBy."fullName" as "requestedByName", prof."fullName" as "residentName"
       FROM "VisitorRequest" vr
       JOIN "Visitor" v ON vr."visitorId" = v.id
       JOIN flats f ON vr."flatId" = f.id
       JOIN wings w ON f."wingId" = w.id
       JOIN societies s ON w."societyId" = s.id
       LEFT JOIN profiles reqBy ON vr."requestedById" = reqBy.id
       JOIN members m ON f.id = m."flatId"
       JOIN profiles prof ON m."profileId" = prof.id
       WHERE vr.id = $1`,
      [id]
    );

    if (requestCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Visitor request not found'
      });
    }

    const request = requestCheck.rows[0];

    // Only allow updating pending requests
    if (request.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Only pending requests can be updated'
      });
    }

    // Verify that the authenticated user is a resident of the flat
    if (user.role !== 'resident') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'Only residents can approve/reject visitor requests'
      });
    }

    // Check if the resident belongs to this flat
    const residentCheck = await client.query(
      'SELECT m.id FROM members m WHERE m."profileId" = $1 AND m."flatId" = $2',
      [req.user.id, request.flatId]
    );

    if (residentCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'You can only approve/reject visitors for your own flat'
      });
    }

    // Update visitor request status
    const result = await client.query(
      `UPDATE "VisitorRequest"
       SET status = $1, "resolvedAt" = NOW()
       WHERE id = $2
       RETURNING id, "purpose", "flatId", "visitorId", "requestedById", "requestedAt", status, "resolvedAt"`,
      [value.status, id]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: `Visitor request ${value.status.toLowerCase()} successfully`,
      data: {
        visitorRequest: result.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Update visitor request error:', error);
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

// Mark visitor entry (by guard)
router.post('/request/:id/entry', authenticateToken, authorizeRole('guard'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { error, value } = entryLogSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if visitor request exists and is approved
    const requestCheck = await client.query(
      `SELECT vr.*, v.name as "visitorName", f."flatNumber",
              reqBy."fullName" as "requestedByName"
       FROM "VisitorRequest" vr
       JOIN "Visitor" v ON vr."visitorId" = v.id
       JOIN flats f ON vr."flatId" = f.id
       LEFT JOIN profiles reqBy ON vr."requestedById" = reqBy.id
       WHERE vr.id = $1`,
      [id]
    );

    if (requestCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Visitor request not found'
      });
    }

    const request = requestCheck.rows[0];

    // Only allow marking entry for approved requests
    if (request.status !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Only approved visitors can be marked as entered'
      });
    }

    // Verify that the authenticated guard is the one who requested this visitor
    if (request.requestedById !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You can only mark entry for visitors you requested'
      });
    }

    // Check if entry log already exists
    const existingEntry = await client.query(
      'SELECT id FROM "EntryLog" WHERE "visitorRequestId" = $1',
      [id]
    );

    if (existingEntry.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Entry already recorded for this visitor'
      });
    }

    // Update visitor request status and create entry log
    const updateResult = await client.query(
      `UPDATE "VisitorRequest"
       SET status = 'CHECKED_IN', "entryTime" = NOW()
       WHERE id = $1
       RETURNING id, status, "entryTime"`,
      [id]
    );

    const entryResult = await client.query(
      `INSERT INTO "EntryLog" ("visitorRequestId", "entryTime", "processedById")
       VALUES ($1, NOW(), $2)
       RETURNING id, "visitorRequestId", "entryTime", "processedById"`,
      [id, value.processedById]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Visitor marked as entered successfully',
      data: {
        visitorRequest: updateResult.rows[0],
        entryLog: entryResult.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Mark visitor entry error:', error);
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

// Mark visitor exit (by guard)
router.post('/request/:id/exit', authenticateToken, authorizeRole('guard'), async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    client = await pool.connect();
    await client.query('BEGIN');

    // Check if visitor request exists and is checked in
    const requestCheck = await client.query(
      `SELECT vr.*, v.name as "visitorName", f."flatNumber",
              reqBy."fullName" as "requestedByName",
              el.id as "entryLogId", el."entryTime"
       FROM "VisitorRequest" vr
       JOIN "Visitor" v ON vr."visitorId" = v.id
       JOIN flats f ON vr."flatId" = f.id
       LEFT JOIN profiles reqBy ON vr."requestedById" = reqBy.id
       LEFT JOIN "EntryLog" el ON vr.id = el."visitorRequestId"
       WHERE vr.id = $1`,
      [id]
    );

    if (requestCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Visitor request not found'
      });
    }

    const request = requestCheck.rows[0];

    // Only allow marking exit for checked-in visitors
    if (request.status !== 'CHECKED_IN') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Only checked-in visitors can be marked as exited'
      });
    }

    // Check if entry log exists
    if (!request.entryLogId) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'No entry record found for this visitor'
      });
    }

    // Verify that the authenticated guard is the one who processed this visitor's entry
    // We need to get the processedById from the entry log
    const entryCheck = await client.query(
      'SELECT "processedById" FROM "EntryLog" WHERE id = $1',
      [request.entryLogId]
    );

    if (entryCheck.rows.length === 0 || entryCheck.rows[0].processedById !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You can only mark exit for visitors you processed'
      });
    }

    // Update visitor request status and update exit time in entry log
    const updateResult = await client.query(
      `UPDATE "VisitorRequest"
       SET status = 'CHECKED_OUT', "exitTime" = NOW()
       WHERE id = $1
       RETURNING id, status, "exitTime"`,
      [id]
    );

    const exitResult = await client.query(
      `UPDATE "EntryLog"
       SET "exitTime" = NOW()
       WHERE id = $1
       RETURNING id, "visitorRequestId", "entryTime", "exitTime"`,
      [request.entryLogId]
    );

    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: 'Visitor marked as exited successfully',
      data: {
        visitorRequest: updateResult.rows[0],
        entryLog: exitResult.rows[0]
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Mark visitor exit error:', error);
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

// Get dashboard statistics for guards
router.get('/dashboard/stats', authenticateToken, authorizeRole('guard'), async (req, res) => {
  let client;
  try {
    client = await pool.connect();

    // Get today's date range
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));

    // Get today's visitor count by type
    const todayVisitorsByTypeResult = await client.query(`
      SELECT v.type, COUNT(*) as count
      FROM "VisitorRequest" vr
      JOIN "Visitor" v ON vr."visitorId" = v.id
      WHERE vr."requestedAt" >= $1 AND vr."requestedAt" <= $2
      GROUP BY v.type
    `, [startOfDay, endOfDay]);

    // Get pending approvals count
    const pendingApprovalsResult = await client.query(`
      SELECT COUNT(*) as count
      FROM "VisitorRequest"
      WHERE status = 'PENDING'
    `);

    // Get today's entries/exits
    const todayEntriesResult = await client.query(`
      SELECT COUNT(*) as count
      FROM "VisitorRequest"
      WHERE "entryTime" >= $1 AND "entryTime" <= $2
    `, [startOfDay, endOfDay]);

    const todayExitsResult = await client.query(`
      SELECT COUNT(*) as count
      FROM "VisitorRequest"
      WHERE "exitTime" >= $1 AND "exitTime" <= $2
    `, [startOfDay, endOfDay]);

    // Get currently on-premises visitors (checked in but not checked out)
    const currentlyOnPremisesResult = await client.query(`
      SELECT COUNT(*) as count
      FROM "VisitorRequest"
      WHERE status = 'CHECKED_IN'
    `);

    // Format visitor type counts
    const visitorsByType = {};
    todayVisitorsByTypeResult.rows.forEach(row => {
      visitorsByType[row.type.toLowerCase()] = parseInt(row.count);
    });

    // Ensure all types are present with default 0
    const visitorTypes = ['guest', 'delivery', 'cab', 'service'];
    visitorTypes.forEach(type => {
      if (!visitorsByType[type]) {
        visitorsByType[type] = 0;
      }
    });

    res.status(200).json({
      success: true,
      data: {
        todayVisitors: visitorsByType,
        pendingApprovals: parseInt(pendingApprovalsResult.rows[0].count),
        todayEntries: parseInt(todayEntriesResult.rows[0].count),
        todayExits: parseInt(todayExitsResult.rows[0].count),
        currentlyOnPremises: parseInt(currentlyOnPremisesResult.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
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

// Get visitor history with filtering
router.get('/history', authenticateToken, async (req, res) => {
  let client;
  try {
    const {
      startDate,
      endDate,
      visitorType,
      status,
      flatId
    } = req.query;

    let query = `
      SELECT vr.*,
             v.name as "visitorName", v.phone as "visitorPhone", v."photoUrl", v.type,
             f."flatNumber", w.name as "wingName", s.name as "societyName",
             reqBy."fullName" as "requestedByName",
             procBy."fullName" as "processedByName",
             el."entryTime" as "logEntryTime", el."exitTime" as "logExitTime"
      FROM "VisitorRequest" vr
      JOIN "Visitor" v ON vr."visitorId" = v.id
      JOIN flats f ON vr."flatId" = f.id
      JOIN wings w ON f."wingId" = w.id
      JOIN societies s ON w."societyId" = s.id
      LEFT JOIN profiles reqBy ON vr."requestedById" = reqBy.id
      LEFT JOIN profiles procBy ON vr."processedById" = procBy.id
      LEFT JOIN "EntryLog" el ON vr.id = el."visitorRequestId"
      WHERE 1=1
    `;
    const values = [];
    let paramIndex = 1;

    // Add filters
    if (visitorType && visitorType !== 'all') {
      query += ` AND v.type = $${paramIndex++}`;
      values.push(visitorType);
    }

    if (status && status !== 'all') {
      query += ` AND vr.status = $${paramIndex++}`;
      values.push(status);
    }

    if (flatId) {
      query += ` AND vr."flatId" = $${paramIndex++}`;
      values.push(flatId);
    }

    if (startDate) {
      query += ` AND vr."requestedAt" >= $${paramIndex++}`;
      values.push(startDate);
    }

    if (endDate) {
      query += ` AND vr."requestedAt" <= $${paramIndex++}`;
      values.push(endDate);
    }

    // For residents, only show requests for their flats
    if (req.user.role === 'resident') {
      // Get the flat ID for the resident
      const memberResult = await client.query(
        'SELECT f.id FROM members m JOIN flats f ON m."flatId" = f.id WHERE m."profileId" = $1',
        [req.user.id]
      );

      if (memberResult.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'User not associated with any flat'
        });
      }

      query += ` AND vr."flatId" = $${paramIndex++}`;
      values.push(memberResult.rows[0].id);
    }

    query += ` ORDER BY vr."requestedAt" DESC`;

    const result = await client.query(query, values);

    res.status(200).json({
      success: true,
      data: {
        visitorRequests: result.rows
      }
    });
  } catch (error) {
    console.error('Get visitor history error:', error);
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