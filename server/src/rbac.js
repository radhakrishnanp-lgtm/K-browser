'use strict';
// Console roles. "admin" can do everything; "helpdesk" handles day-to-day
// staff support; "auditor" can look but not change anything. None of them can
// ever read a stored website password.
const ROLES = {
  admin: { label: 'Administrator', perms: ['*'] },
  helpdesk: { label: 'Helpdesk', perms: ['read', 'users:write', 'sessions:write', 'requests:write'] },
  auditor: { label: 'Auditor (read-only)', perms: ['read'] },
  user: { label: 'Staff', perms: [] },
};

const CONSOLE_ROLES = ['admin', 'helpdesk', 'auditor'];

function can(user, perm) {
  const role = ROLES[user && user.role] || ROLES.user;
  return role.perms.includes('*') || role.perms.includes(perm);
}

module.exports = { ROLES, CONSOLE_ROLES, can };
