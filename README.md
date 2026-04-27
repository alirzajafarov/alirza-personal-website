# alirza.com Blog System — Setup Guide

## File Structure
```
/var/www/alirza.com/
├── index.html              # Main site
├── favicon.svg             # Circular favicon
├── server.js               # Node.js blog API
├── admin/
│   └── index.html          # Admin panel (login + editor)
├── journal/
│   ├── index.html          # Public journal listing
│   └── *.html              # Auto-generated post pages
├── data/
│   ├── users.json           # Admin credentials (auto-created)
│   ├── posts-index.json     # Published posts index (auto-generated)
│   └── posts/
│       └── *.json           # Post data files
└── css/
    └── article.css          # Article page styles (optional, can be inline)
```

## Quick Start on Hetzner VPS

### 1. Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs
```

### 2. Upload files
```bash
mkdir -p /var/www/alirza.com
# Upload all files to /var/www/alirza.com/
```

### 3. Start the blog API
```bash
cd /var/www/alirza.com
node server.js
# Default login: alirza / admin123
# CHANGE THE PASSWORD IMMEDIATELY via admin panel or API
```

### 4. Run with PM2 (production)
```bash
npm install -g pm2
cd /var/www/alirza.com
pm2 start server.js --name blog-api
pm2 save
pm2 startup
```

### 5. Nginx config
```nginx
server {
    listen 80;
    server_name alirza.com www.alirza.com;
    root /var/www/alirza.com;
    index index.html;

    # Custom 404
    error_page 404 /404.html;

    # Static files
    location / {
        try_files $uri $uri/ =404;
    }

    # Blog API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Admin panel
    location /admin {
        try_files $uri $uri/ /admin/index.html;
    }

    # Journal pages
    location /journal {
        try_files $uri $uri/ /journal/index.html;
    }

    # RSS feed
    location = /feed.xml {
        add_header Content-Type application/rss+xml;
    }

    # Cache static assets
    location ~* \.(jpg|jpeg|png|webp|gif|svg|css|js)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";
    
    # Block admin from non-localhost (optional extra security)
    # location /admin {
    #     allow YOUR_IP;
    #     deny all;
    #     try_files $uri $uri/ /admin/index.html;
    # }
}
```

### 6. SSL with Let's Encrypt
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d alirza.com -d www.alirza.com
```

### 7. DNS Setup
Point your domain to VPS IP:
- A record: alirza.com → YOUR_VPS_IP
- A record: www.alirza.com → YOUR_VPS_IP

## Usage

### Writing a post
1. Go to alirza.com/admin
2. Login with your credentials
3. Click "+ New Post"
4. Write in markdown (left pane), preview (right pane)
5. Click "Publish" — post is live immediately

### Markdown syntax
```
## Heading 2
### Heading 3
**bold** and *italic*
[link text](url)
![image alt](image-url)
> blockquote
- list item
--- horizontal rule
>>> pullquote text <<<
```

### First thing to do
Change the default password! Login to admin panel and use the API:
```bash
curl -X POST http://localhost:3001/api/change-password \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"newPassword": "your-secure-password"}'
```
