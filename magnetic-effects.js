/**
 * Phase 4: Magnetic Hover Effects & Micro-Animations
 * Tactile feedback for interactive elements
 */

var MagneticEffects = (function() {
    var magneticElements = [];
    var animationFrame = null;
    
    function init() {
        // Initialize magnetic buttons
        initMagneticButtons();
        
        // Initialize hover effects
        initHoverEffects();
        
        // Initialize ripple effects
        initRippleEffects();
        
        // Initialize focus animations
        initFocusAnimations();
    }
    
    function initMagneticButtons() {
        var buttons = document.querySelectorAll('.hero-card, .hero-start, .composer-send, .diff-action-btn, .preview-action-btn');
        
        buttons.forEach(function(btn) {
            btn.classList.add('magnetic-element');
            
            btn.addEventListener('mousemove', function(e) {
                var rect = btn.getBoundingClientRect();
                var x = e.clientX - rect.left - rect.width / 2;
                var y = e.clientY - rect.top - rect.height / 2;
                
                // Magnetic pull effect
                var strength = 0.3;
                btn.style.transform = 'translate(' + (x * strength) + 'px, ' + (y * strength) + 'px)';
            });
            
            btn.addEventListener('mouseleave', function() {
                btn.style.transform = 'translate(0, 0)';
            });
        });
    }
    
    function initHoverEffects() {
        // Add hover scale effect to cards
        var cards = document.querySelectorAll('.hero-card, .provider-health-card, .diff-line');
        
        cards.forEach(function(card) {
            card.addEventListener('mouseenter', function() {
                card.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';
                card.style.transform = 'translateY(-2px) scale(1.02)';
                card.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.2)';
            });
            
            card.addEventListener('mouseleave', function() {
                card.style.transform = 'translateY(0) scale(1)';
                card.style.boxShadow = '';
            });
        });
        
        // Add glow effect to primary buttons
        var primaryBtns = document.querySelectorAll('.composer-send, .diff-accept-all');
        
        primaryBtns.forEach(function(btn) {
            btn.addEventListener('mouseenter', function() {
                btn.style.boxShadow = '0 0 20px rgba(34, 211, 238, 0.4)';
            });
            
            btn.addEventListener('mouseleave', function() {
                btn.style.boxShadow = '';
            });
        });
    }
    
    function initRippleEffects() {
        // Add ripple effect to clickable elements
        var clickables = document.querySelectorAll('button, .hero-card, .hero-start, .palette-item');
        
        clickables.forEach(function(el) {
            el.addEventListener('click', function(e) {
                var rect = el.getBoundingClientRect();
                var x = e.clientX - rect.left;
                var y = e.clientY - rect.top;
                
                var ripple = document.createElement('span');
                ripple.className = 'magnetic-ripple';
                ripple.style.left = x + 'px';
                ripple.style.top = y + 'px';
                
                el.appendChild(ripple);
                
                setTimeout(function() {
                    ripple.remove();
                }, 600);
            });
        });
    }
    
    function initFocusAnimations() {
        // Add focus ring animation
        var inputs = document.querySelectorAll('input, textarea, select');
        
        inputs.forEach(function(input) {
            input.addEventListener('focus', function() {
                input.classList.add('magnetic-focus');
            });
            
            input.addEventListener('blur', function() {
                input.classList.remove('magnetic-focus');
            });
        });
    }
    
    // Expose for external use
    return {
        init: init
    };
})();

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    MagneticEffects.init();
});
