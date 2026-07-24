@echo off
cd /d "C:\Users\dhcon\Projects\News Quiz"
echo === %DATE% %TIME% === >> outreach-log.txt
node outreach.js >> outreach-log.txt 2>&1
