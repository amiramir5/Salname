/** @type {import('tailwindcss').Config} */
module.exports = {
    // index.html is the only source of class names. Both the markup and the
    // class strings written inside the JavaScript live in that one file, and no
    // class name is ever assembled from fragments — which is what makes a
    // static build a drop-in replacement for the cdn.tailwindcss.com runtime.
    content: ['./index.html'],
    theme: {
        extend: {}
    },
    plugins: []
};
